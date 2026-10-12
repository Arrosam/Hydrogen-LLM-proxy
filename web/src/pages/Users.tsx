import { ROLE, ROLES, useAuth } from "../auth";
import { useAsync } from "../lib/hooks";
import { useDeleteAction, useFormState, useSave } from "../lib/crud";
import { API } from "../lib/endpoints";
import { ENTITY_ICON } from "../lib/icons";
import { useI18n } from "../lib/i18n";
import { fetchUsers } from "../lib/resources";
import { EnabledBadge, RoleBadge } from "../components/badges";
import { Button } from "../components/Button";
import { EmptyState, Toggle, useConfirm } from "../components/common";
import { DataTable, type Column } from "../components/DataTable";
import { RowActions } from "../components/EntityCard";
import { Field, FieldHint } from "../components/Field";
import { FormModal } from "../components/FormModal";
import { Select, TextInput } from "../components/inputs";
import { ResourcePage } from "../components/Page";
import { formatDate } from "../lib/format";
import type { Role, User } from "../types";

interface FormState {
  id?: number;
  username: string;
  password: string;
  role: Role;
  enabled: boolean;
}

const EMPTY: FormState = { username: "", password: "", role: ROLE.manager, enabled: true };

// The route and the API are both admin-only, so this page never renders for a
// manager and needs no per-role degradation.
export function Users() {
  const { t } = useI18n();
  const { user: me } = useAuth();
  const state = useAsync(fetchUsers);
  const { data, reload } = state;
  const { confirm, confirmEl } = useConfirm();
  const fc = useFormState<FormState>();
  const { form } = fc;

  const { save, saving } = useSave(fc, {
    collection: API.users,
    member: API.user,
    // An edit never renames, and only resets the password when one was typed.
    toPayload: (f) =>
      f.id
        ? { role: f.role, enabled: f.enabled, ...(f.password ? { password: f.password } : {}) }
        : { username: f.username, password: f.password, role: f.role, enabled: f.enabled },
    messages: (editing) => ({
      success: t(editing ? "users.toast.updated" : "users.toast.created"),
      failed: t("users.toast.saveFailed"),
    }),
    onSaved: reload,
  });

  const del = useDeleteAction(confirm, reload);
  const remove = (u: User) =>
    del({
      title: t("users.confirm.deleteTitle"),
      body: t("users.confirm.deleteBody", { name: u.username }),
      path: API.user(u.id),
      success: t("users.toast.deleted"),
      fallback: t("users.toast.deleteFailed"),
    });

  // Guards for the edit modal's Enabled toggle.
  const users = data ?? [];
  const editTarget = form?.id ? users.find((u) => u.id === form.id) : undefined;
  const enabledAdmins = users.filter((u) => u.role === ROLE.admin && u.enabled);
  const isSelfEdit = !!form?.id && form.id === me?.id;
  const isLastEnabledAdmin =
    !!editTarget && editTarget.role === ROLE.admin && enabledAdmins.length <= 1 && enabledAdmins[0]?.id === form?.id;
  const lockEnabled = isSelfEdit || isLastEnabledAdmin;
  const lockReason = isSelfEdit
    ? t("users.lockReason.self")
    : isLastEnabledAdmin
      ? t("users.lockReason.lastAdmin")
      : "";

  const columns: Column<User>[] = [
    {
      header: t("users.table.username"),
      className: "font-medium text-ink-100",
      cell: (u) => (
        <>
          {u.username}
          {u.id === me?.id && <span className="ml-2 badge-gray">{t("users.youBadge")}</span>}
        </>
      ),
    },
    { header: t("users.table.role"), cell: (u) => <RoleBadge role={u.role} /> },
    {
      header: t("users.table.status"),
      cell: (u) => <EnabledBadge enabled={u.enabled} labels={{ on: t("users.status.active"), off: t("users.status.disabled") }} />,
    },
    { header: t("users.table.created"), className: "text-xs text-ink-400", cell: (u) => formatDate(u.createdAt) },
    {
      header: t("users.table.actions"),
      headerClassName: "text-right",
      cell: (u) => (
        <RowActions
          className="justify-end"
          onEdit={() => fc.open({ id: u.id, username: u.username, password: "", role: u.role, enabled: u.enabled })}
          onDelete={() => remove(u)}
          deleteDisabled={u.id === me?.id}
        />
      ),
    },
  ];

  return (
    <ResourcePage
      title={t("users.title")}
      subtitle={t("users.subtitle")}
      icon={ENTITY_ICON.user}
      action={
        <Button variant="primary" icon="bi-person-plus" onClick={() => fc.open({ ...EMPTY })}>
          {t("users.action.new")}
        </Button>
      }
      state={state}
      isEmpty={(list) => list.length === 0}
      empty={<EmptyState icon={ENTITY_ICON.user} title={t("users.empty.title")} />}
    >
      {data && data.length > 0 && <DataTable rows={data} rowKey={(u) => u.id} columns={columns} />}

      <FormModal
        open={form !== null}
        title={form?.id ? t("users.modal.editTitle") : t("users.modal.createTitle")}
        icon="bi-person"
        onClose={fc.close}
        onSubmit={save}
        submitLabel={t("users.action.save")}
        cancelLabel={t("users.action.cancel")}
        busy={saving}
      >
        {form && (
          <div className="space-y-4">
            {!form.id && (
              <Field label={t("users.form.username")}>
                <TextInput {...fc.bind("username")} />
              </Field>
            )}
            <Field label={form.id ? t("users.form.resetPassword") : t("users.form.password")}>
              <TextInput type="password" {...fc.bind("password")} placeholder={t("users.form.passwordPlaceholder")} />
            </Field>
            <Field label={t("users.form.role")}>
              <Select
                value={form.role}
                onChange={(role) => fc.set("role", role)}
                options={ROLES.map((role) => ({ value: role, label: t(`users.role.${role}`) }))}
              />
            </Field>
            <div>
              <Toggle checked={form.enabled} onChange={(v) => fc.set("enabled", v)} label={t("users.form.enabled")} disabled={lockEnabled} />
              {lockReason && <FieldHint>{lockReason}</FieldHint>}
            </div>
          </div>
        )}
      </FormModal>
      {confirmEl}
    </ResourcePage>
  );
}
