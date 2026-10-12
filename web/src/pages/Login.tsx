import { useState } from "react";
import { useAuth } from "../auth";
import { AuthCard } from "../components/AuthCard";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { TextInput } from "../components/inputs";
import { HydrogenLogo } from "../components/Logo";
import { errorMessage } from "../lib/errors";
import { useAction } from "../lib/hooks";
import { useI18n } from "../lib/i18n";

export function Login() {
  const { t } = useI18n();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const action = useAction({ onError: setError, describe: errorMessage });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    await action.run(() => login(username, password), t("login.error.fallback"));
  };

  return (
    <AuthCard
      mark={<HydrogenLogo className="h-14 w-14" />}
      title={t("login.brand")}
      subtitle={t("login.subtitle")}
      onSubmit={submit}
      error={error}
      actions={
        <Button variant="primary" className="w-full" icon="bi-box-arrow-in-right" busy={action.busy} spinWhenBusy>
          {t("login.form.submit")}
        </Button>
      }
    >
      <Field label={t("login.form.username")}>
        <TextInput value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
      </Field>
      <Field label={t("login.form.password")}>
        <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </Field>
    </AuthCard>
  );
}
