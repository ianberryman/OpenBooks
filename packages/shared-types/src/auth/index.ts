/**
 * The session-authentication wire contract (OB-023). Read `auth.ts` for why the
 * credential fields carry no format rules and why no response carries a token.
 */
export type { IdentityResponse, LoginRequest, RegisterRequest } from './auth';
export {
  authenticatedUserSchema,
  identityResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
} from './auth';
