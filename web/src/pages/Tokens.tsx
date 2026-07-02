import { useState } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { useAsync } from "../lib/hooks";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { copyToClipboard } from "../lib/clipboard";
import { formatDate, formatNumber } from "../lib/format";
import type { Mub, Token } from "../types";

interface Data {
  tokens: Token[];
  mubs: Mub[];
}

interface FormState {
  name: string;
  scopeMubs: number[];
  scopeAll: boolean;
  maxRequests: string;
  maxTokens: string;
  expiresAt: string;
  enabled: boolean;
}

const EMPTY: FormState = {
  name: "",
  scopeMubs: [],
  scopeAll: true,
  maxRequests: "",
  maxTokens: "",
  expiresAt: "",
  enabled: true,
};

export function Tokens() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const { data, loading, error, reload } = useAsync<Data>(async () => {
    const [t, m] = await Promise.all([
      api.get<{ tokens: Token[] }>("/tokens"),
      api.get<{ mubs: Mub[] }>("/mubs"),
    ]);
    return { tokens: t.tokens, mubs: m.mubs };
  });
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const mubName = (id: number) => data?.mubs.find((m) => m.id === id)?.name ?? `#${id}`;

  const create = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        scopeMubs: form.scopeAll ? null : form.scopeMubs,
        maxRequests: form.maxRequests ? Number(form.maxRequests) : null,
        maxTokens: form.maxTokens ? Number(form.maxTokens) : null,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).getTime() : null,
        enabled: form.enabled,
      };
      const r = await api.post<{ secret: string }>("/tokens", payload);
      setForm(null);
      setSecret(r.secret);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (t: Token) => {
    try {
      await api.patch(`/tokens/${t.id}`, { enabled: !t.enabled });
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed");
    }
  };

  const remove = async (t: Token) => {
    if (!(await confirm("Revoke token", `Revoke "${t.name}"? Any client using it will stop working immediately.`))) return;
    try {
      await api.del(`/tokens/${t.id}`);
      toast.success("Token revoked");
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Failed");
    }
  };

  const copySecret = async () => {
    if (!secret) return;
    const ok = await copyToClipboard(secret);
    if (ok) toast.success("Copied to clipboard");
    else toast.error("Copy failed - select the token and copy it manually");
  };

  return (
    <div>
      <PageHeader
        title="Tokens"
        subtitle="Client API keys. Scope each to specific MUBs and set optional quotas."
        icon="bi-key"
        action={
          isAdmin ? (
            <button className="btn-primary" onClick={() => setForm({ ...EMPTY })}>
              <i className="bi bi-plus-lg" />
              Issue token
            </button>
          ) : (
            <span className="badge-gray"><i className="bi bi-shield-lock" />only admins can issue tokens</span>
          )
        }
      />
      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {data && data.tokens.length === 0 && (
        <EmptyState icon="bi-key" title="No tokens yet" hint={isAdmin ? "Issue a token to let a client call your MUB endpoints." : "Ask an admin to issue a token."} />
      )}

      {data && data.tokens.length > 0 && (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Scope</th>
                <th>Requests</th>
                <th>Tokens</th>
                <th>Expires</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((t) => (
                <tr key={t.id}>
                  <td className="font-medium text-ink-100">{t.name}</td>
                  <td className="font-mono text-xs text-ink-400">{t.keyPrefix}...</td>
                  <td className="text-xs">
                    {!t.scopeMubs || t.scopeMubs.length === 0 ? (
                      <span className="badge-gray">all MUBs</span>
                    ) : (
                      <span className="text-ink-300">{t.scopeMubs.map(mubName).join(", ")}</span>
                    )}
                  </td>
                  <td className="text-xs text-ink-300">
                    {formatNumber(t.usedRequests)}{t.maxRequests ? ` / ${formatNumber(t.maxRequests)}` : ""}
                  </td>
                  <td className="text-xs text-ink-300">
                    {formatNumber(t.usedTokens)}{t.maxTokens ? ` / ${formatNumber(t.maxTokens)}` : ""}
                  </td>
                  <td className="text-xs text-ink-400">{t.expiresAt ? formatDate(t.expiresAt) : "never"}</td>
                  <td><Toggle checked={t.enabled} onChange={() => toggleEnabled(t)} /></td>
                  <td>
                    <div className="flex justify-end">
                      <button className="btn-danger btn-xs" onClick={() => remove(t)}>
                        <i className="bi bi-x-circle" />
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create form */}
      <Modal
        open={form !== null}
        title="Issue token"
        icon="bi-key"
        onClose={() => setForm(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn-primary" onClick={create} disabled={saving || !form?.name}>
              <i className="bi bi-check-lg" />Issue
            </button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            <div>
              <label className="label">Name</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. my-laptop" />
            </div>
            <div>
              <label className="label">Scope</label>
              <label className="mb-2 flex items-center gap-2 text-sm text-ink-300">
                <input type="checkbox" checked={form.scopeAll} onChange={(e) => setForm({ ...form, scopeAll: e.target.checked })} />
                Allow all MUBs
              </label>
              {!form.scopeAll && (
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-ink-800 p-2">
                  {data?.mubs.map((m) => (
                    <label key={m.id} className="flex items-center gap-2 text-sm text-ink-300">
                      <input
                        type="checkbox"
                        checked={form.scopeMubs.includes(m.id)}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            scopeMubs: e.target.checked ? [...form.scopeMubs, m.id] : form.scopeMubs.filter((x) => x !== m.id),
                          })
                        }
                      />
                      <span className="font-mono text-xs">{m.name}</span>
                    </label>
                  ))}
                  {data?.mubs.length === 0 && <p className="text-xs text-ink-500">No MUBs to scope to.</p>}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Max requests (optional)</label>
                <input className="input" type="number" value={form.maxRequests} onChange={(e) => setForm({ ...form, maxRequests: e.target.value })} />
              </div>
              <div>
                <label className="label">Max tokens (optional)</label>
                <input className="input" type="number" value={form.maxTokens} onChange={(e) => setForm({ ...form, maxTokens: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label">Expires at (optional)</label>
              <input className="input" type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
            </div>
            <Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="Enabled" />
          </div>
        )}
      </Modal>

      {/* Reveal-once secret */}
      <Modal
        open={secret !== null}
        title="Token created"
        icon="bi-clipboard-check"
        onClose={() => setSecret(null)}
        footer={<button className="btn-primary" onClick={() => setSecret(null)}>Done</button>}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
            <i className="bi bi-exclamation-triangle-fill" />
            Copy this now - it is shown only once and never stored in plaintext.
          </div>
          <div className="flex items-center gap-2">
            <code
              title="Click to select"
              onClick={(e) => {
                const range = document.createRange();
                range.selectNodeContents(e.currentTarget);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
              }}
              className="flex-1 cursor-text overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-xs text-brand-400"
            >
              {secret}
            </code>
            <button className="btn-ghost" onClick={copySecret}>
              <i className="bi bi-clipboard" />
            </button>
          </div>
        </div>
      </Modal>
      {confirmEl}
    </div>
  );
}
