/** Browser-safe account DTOs. Never include password records or session tokens. */
export type WebUserRole = "admin" | "user";
export interface WebUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: WebUserRole;
  readonly disabled: boolean;
  readonly version: number;
  readonly grants: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface CreateWebUserInput {
  readonly username: string;
  readonly displayName?: string;
  readonly password: string;
  readonly role: WebUserRole;
  readonly grants?: readonly string[];
}
export interface PatchWebUserInput {
  readonly displayName?: string;
  readonly role?: WebUserRole;
  readonly disabled?: boolean;
  readonly grants?: readonly string[];
}
