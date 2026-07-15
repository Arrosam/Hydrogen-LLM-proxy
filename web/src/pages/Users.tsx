import { useState } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { useAsync } from "../lib/hooks";
import { useI18n } from "../lib/i18n";
import { PageHeader } from "../components/Layout";
import { EmptyState, ErrorNote, Spinner, Toggle, useConfirm } from "../components/common";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { formatDate } from "../lib/format";
import type { Role, User } from "../types";

interface FormState {
  id?: number;
  username: string;
  password: string;
  role: Role;
  enabled: boolean;
}

export function Users() {
  const { t } = useI18n();
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { data, loading, error, reload } = useAsync(() => api.get<{ users: User[] }>("/users"));
  const toast = useToast();
  const { confirm, confirmEl } = useConfirm();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      if (form.id) {
        const payload: Record<string, unknown> = { role: form.role, enabled: form.enabled };
        if (form.password) payload.password = form.password;
        await api.patch(`/users/${form.id}`, payload);
        toast.success(t("users.toast.updated"));
      } else {
        await api.post("/users", { username: form.username, password: form.password, role: form.role, enabled: form.enabled });
        toast.success(t("users.toast.created"));
      }
      setForm(null);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("users.toast.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (u: User) => {
    if (!(await confirm(t("users.confirm.deleteTitle"), t("users.confirm.deleteBody", { name: u.username })))) return;
    try {
      await api.del(`/users/${u.id}`);
      toast.success(t("users.toast.deleted"));
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("users.toast.deleteFailed"));
    }
  };

  const canManage = (u: User) => isAdmin || u.role !== "admin";

  // Guards for the edit modal's Enabled toggle.
  const users = data?.users ?? [];
  const editTarget = form?.id ? users.find((u) => u.id === form.id) : undefined;
  const enabledAdmins = users.filter((u) => u.role === "admin" && u.enabled);
  const isSelfEdit = !!form?.id && form.id === me?.id;
  const isLastEnabledAdmin =
    !!editTarget && editTarget.role === "admin" && enabledAdmins.length <= 1 && enabledAdmins[0]?.id === form?.id;
  const lockEnabled = isSelfEdit || isLastEnabledAdmin;
  const lockReason = isSelfEdit
    ? t("users.lockReason.self")
    : isLastEnabledAdmin
      ? t("users.lockReason.lastAdmin")
      : "";

  return (
    <div>
      <PageHeader
        title={t("users.title")}
        subtitle={t("users.subtitle")}
        icon="bi-people"
        action={
          <button className="btn-primary" onClick={() => setForm({ username: "", password: "", role: "manager", enabled: true })}>
            <i className="bi bi-person-plus" />
            {t("users.action.new")}
          </button>
        }
      />
      {loading && <Spinner />}
      {error && <ErrorNote message={error} />}
      {data && data.users.length === 0 && <EmptyState icon="bi-people" title={t("users.empty.title")} />}

      {data && data.users.length > 0 && (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>{t("users.table.username")}</th>
                <th>{t("users.table.role")}</th>
                <th>{t("users.table.status")}</th>
                <th>{t("users.table.created")}</th>
                <th className="text-right">{t("users.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td className="font-medium text-ink-100">
                    {u.username}
                    {u.id === me?.id && <span className="ml-2 badge-gray">{t("users.youBadge")}</span>}
                  </td>
                  <td>
                    <span className={u.role === "admin" ? "badge-blue" : "badge-gray"}>
                      <i className={`bi ${u.role === "admin" ? "bi-shield-lock" : "bi-person-gear"}`} />
                      {u.role}
                    </span>
                  </td>
                  <td>{u.enabled ? <span className="badge-green">{t("users.status.active")}</span> : <span className="badge-red">{t("users.status.disabled")}</span>}</td>
                  <td className="text-xs text-ink-400">{formatDate(u.createdAt)}</td>
                  <td>
                    <div className="flex justify-end gap-1.5">
                      <button
                        className="btn-ghost btn-xs"
                        disabled={!canManage(u)}
                        onClick={() => setForm({ id: u.id, username: u.username, password: "", role: u.role, enabled: u.enabled })}
                      >
                        <i className="bi bi-pencil" />
                      </button>
                      <button className="btn-danger btn-xs" disabled={!canManage(u) || u.id === me?.id} onClick={() => remove(u)}>
                        <i className="bi bi-trash3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={form !== null}
        title={form?.id ? t("users.modal.editTitle") : t("users.modal.createTitle")}
        icon="bi-person"
        onClose={() => setForm(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setForm(null)}>{t("users.action.cancel")}</button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              <i className="bi bi-check-lg" />{t("users.action.save")}
            </button>
          </>
        }
      >
        {form && (
          <div className="space-y-4">
            {!form.id && (
              <div>
                <label className="label">{t("users.form.username")}</label>
                <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              </div>
            )}
            <div>
              <label className="label">{form.id ? t("users.form.resetPassword") : t("users.form.password")}</label>
              <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={t("users.form.passwordPlaceholder")} />
            </div>
            <div>
              <label className="label">{t("users.form.role")}</label>
              <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} disabled={!isAdmin}>
                <option value="manager">{t("users.role.manager")}</option>
                <option value="admin">{t("users.role.admin")}</option>
              </select>
              {!isAdmin && <p className="mt-1 text-xs text-ink-500">{t("users.form.adminRoleRestricted")}</p>}
            </div>
            <div>
              <Toggle
                checked={form.enabled}
                onChange={(v) => setForm({ ...form, enabled: v })}
                label={t("users.form.enabled")}
                disabled={lockEnabled}
              />
              {lockReason && <p className="mt-1 text-xs text-ink-500">{lockReason}</p>}
            </div>
          </div>
        )}
      </Modal>
      {confirmEl}
    </div>
  );
}
