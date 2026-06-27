import { config } from '../config.js'
import { MCP_SCOPE } from './store.js'

// All OAuth URLs are derived from the public domain. The issuer is the bare
// origin; the MCP endpoint is the protected resource.
function baseUrl(): string {
  return `https://${config.APP_DOMAIN}`
}

export function issuer(): string {
  return baseUrl()
}

export function resourceUrl(): string {
  return `${baseUrl()}/mcp`
}

/** URL of the protected-resource metadata doc, advertised in WWW-Authenticate. */
export function resourceMetadataUrl(): string {
  return `${baseUrl()}/.well-known/oauth-protected-resource`
}

/**
 * Authorization Server Metadata (RFC 8414), served at
 * /.well-known/oauth-authorization-server. PKCE S256 is required; we support the
 * authorization_code and refresh_token grants and dynamic client registration.
 */
export function authServerMetadata() {
  const base = baseUrl()
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: [MCP_SCOPE],
  }
}

/**
 * Protected Resource Metadata (RFC 9728), served at
 * /.well-known/oauth-protected-resource. Points clients at our authorization server.
 */
export function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [issuer()],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: config.APP_DISPLAY_NAME,
  }
}
