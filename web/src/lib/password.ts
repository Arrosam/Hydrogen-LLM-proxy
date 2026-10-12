import { MIN_PASSWORD_LENGTH } from "./constants";

export type PasswordProblem = "tooShort" | "mismatch";

/** Why a new password (typed twice) is not acceptable, or null when it is. */
export function newPasswordProblem(password: string, confirmation: string, minLength: number = MIN_PASSWORD_LENGTH): PasswordProblem | null {
  if (password.length < minLength) return "tooShort";
  if (password !== confirmation) return "mismatch";
  return null;
}
