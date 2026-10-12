import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { AuthCard } from "../components/AuthCard";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { TextInput } from "../components/inputs";
import { API } from "../lib/endpoints";
import { useAction } from "../lib/hooks";
import { ACTION_ICON } from "../lib/icons";
import { useI18n } from "../lib/i18n";
import { newPasswordProblem, type PasswordProblem } from "../lib/password";
import type { User } from "../types";

const PROBLEM_KEY: Record<PasswordProblem, string> = {
  tooShort: "setPassword.error.tooShort",
  mismatch: "setPassword.error.mismatch",
};

export function SetPassword() {
  const { t } = useI18n();
  const { user, setUser, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const action = useAction({ onError: setError });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = newPasswordProblem(password, confirm);
    if (problem) return setError(t(PROBLEM_KEY[problem]));
    setError(null);
    await action.run(async () => {
      const r = await api.post<{ user: User }>(API.changePassword, { newPassword: password, currentPassword });
      setUser(r.user);
    }, t("setPassword.error.fallback"));
  };

  return (
    <AuthCard
      mark={
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600/20 text-brand-400">
          <i className="bi bi-shield-lock text-2xl" />
        </span>
      }
      title={t("setPassword.title")}
      subtitle={t("setPassword.signedInAs", { username: user?.username ?? "" })}
      onSubmit={submit}
      error={error}
      actions={
        <>
          <Button variant="primary" className="w-full" icon={ACTION_ICON.save} busy={action.busy} spinWhenBusy>
            {t("setPassword.form.submit")}
          </Button>
          <Button type="button" variant="ghost" size="xs" className="w-full" icon={ACTION_ICON.signOut} onClick={() => void logout()}>
            {t("setPassword.form.signOut")}
          </Button>
        </>
      }
    >
      <Field label={t("layout.currentPassword")}>
        <TextInput type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required />
      </Field>
      <Field label={t("setPassword.form.newPassword")}>
        <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus placeholder={t("setPassword.form.newPasswordPlaceholder")} autoComplete="new-password" />
      </Field>
      <Field label={t("setPassword.form.confirmPassword")}>
        <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
      </Field>
    </AuthCard>
  );
}
