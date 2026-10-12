import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth, useIsAdmin } from "../auth";
import { useI18n } from "../lib/i18n";
import { api } from "../api";
import { useFields } from "../lib/crud";
import { API } from "../lib/endpoints";
import { useAction, useAttempt } from "../lib/hooks";
import { ACTION_ICON, ENTITY_ICON } from "../lib/icons";
import { newPasswordProblem, type PasswordProblem } from "../lib/password";
import { HOME_PATH, ROUTES, routeVisible } from "../lib/routes";
import { RoleBadge } from "./badges";
import { Button, Icon } from "./Button";
import { Field } from "./Field";
import { FormModal } from "./FormModal";
import { TextInput } from "./inputs";
import { HydrogenLogo } from "./Logo";
import { useToast } from "./Toast";
import type { User } from "../types";

// Every page imports its header from here; it lives with the other page-frame parts.
export { PageHeader } from "./Page";

const PROBLEM_KEY: Record<PasswordProblem, string> = {
  tooShort: "layout.passwordTooShort",
  mismatch: "layout.passwordsDoNotMatch",
};

const EMPTY_PASSWORDS = { current: "", next: "", confirm: "" };

export function Layout() {
  const { user, logout, setUser } = useAuth();
  const isAdmin = useIsAdmin();
  const { t } = useI18n();
  const toast = useToast();
  const [pwOpen, setPwOpen] = useState(false);
  const { values: pw, patch, bind } = useFields(EMPTY_PASSWORDS);
  const action = useAction();
  const attempt = useAttempt();

  const changePassword = async () => {
    const problem = newPasswordProblem(pw.next, pw.confirm);
    if (problem) return toast.error(t(PROBLEM_KEY[problem]));
    await action.run(async () => {
      const r = await api.post<{ user: User }>(API.changePassword, { currentPassword: pw.current, newPassword: pw.next });
      setUser(r.user);
      toast.success(t("layout.passwordChanged"));
      setPwOpen(false);
      patch(EMPTY_PASSWORDS);
    }, t("layout.failed"));
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900/60">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <HydrogenLogo className="h-9 w-9" />
          <div>
            <div className="text-sm font-semibold text-ink-100">{t("brand.name")}</div>
            <div className="text-[11px] text-ink-500">{t("brand.subtitle")}</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {ROUTES.filter((r) => routeVisible(r, isAdmin)).map((r) =>
            r.external ? (
              <a key={r.path} href={r.path} target="_blank" rel="noreferrer" className="nav-link">
                <Icon name={r.icon} className="text-base" />
                <span className="truncate">{t(r.labelKey)}</span>
                <Icon name={ACTION_ICON.external} className="ml-auto text-xs text-ink-500" />
              </a>
            ) : (
              <NavLink key={r.path} to={r.path} end={r.path === HOME_PATH} className="nav-link">
                <Icon name={r.icon} className="text-base" />
                <span className="truncate">{t(r.labelKey)}</span>
              </NavLink>
            ),
          )}
        </nav>

        <div className="border-t border-ink-800 px-4 py-3">
          <div className="mb-2 flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-800 text-ink-300">
              <i className="bi bi-person-fill" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink-100">{user?.username}</div>
              <RoleBadge role={user?.role} />
            </div>
          </div>
          <div className="flex gap-1.5">
            <Button variant="ghost" size="xs" className="flex-1" icon={ENTITY_ICON.token} onClick={() => setPwOpen(true)}>
              {t("layout.passwordButton")}
            </Button>
            <Button variant="ghost" size="xs" className="flex-1" icon={ACTION_ICON.signOut} onClick={() => void attempt(logout, t("layout.toast.signOutFailed"))}>
              {t("layout.signOut")}
            </Button>
          </div>
        </div>
      </aside>

      <FormModal
        open={pwOpen}
        title={t("layout.changePasswordTitle")}
        icon={ENTITY_ICON.token}
        onClose={() => setPwOpen(false)}
        onSubmit={changePassword}
        submitLabel={t("common.update")}
        busy={action.busy}
      >
        <div className="space-y-4">
          <Field label={t("layout.currentPassword")}>
            <TextInput type="password" {...bind("current")} autoComplete="current-password" />
          </Field>
          <Field label={t("layout.newPassword")}>
            <TextInput type="password" {...bind("next")} placeholder={t("layout.passwordPlaceholder")} autoComplete="new-password" />
          </Field>
          <Field label={t("layout.confirmNewPassword")}>
            <TextInput type="password" {...bind("confirm")} autoComplete="new-password" />
          </Field>
        </div>
      </FormModal>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
