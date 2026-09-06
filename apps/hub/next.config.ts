import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const workspacePackages = [
  "@portal/protocol",
  "@portal/identity",
  "@portal/catalog",
  "@portal/registry",
];

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source rather than built JS, so Next
  // compiles them alongside the app instead of treating them as external.
  transpilePackages: workspacePackages,
  // `fileURLToPath`, not `.pathname`: a URL percent-encodes, so a checkout under
  // a path with a space would hand Next `/Users/me/My%20Projects/...`, which is
  // not a directory that exists.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  // OAuth discovery lives under `/.well-known/`, and Next's router will not
  // serve a directory whose name starts with a dot. The documents are therefore
  // ordinary routes under `/api/well-known/` and are published at their spec
  // paths here.
  //
  // The `:path*` on the first rule is load-bearing: an MCP client probes the
  // path-aware `/.well-known/oauth-protected-resource/api/mcp` before falling
  // back to the bare form, and both have to reach the one document describing
  // the one protected resource this hub has.
  async rewrites() {
    return [
      {
        source: "/.well-known/oauth-protected-resource/:path*",
        destination: "/api/well-known/oauth-protected-resource",
      },
      {
        source: "/.well-known/oauth-protected-resource",
        destination: "/api/well-known/oauth-protected-resource",
      },
      {
        source: "/.well-known/oauth-authorization-server/:path*",
        destination: "/api/well-known/oauth-authorization-server",
      },
      {
        source: "/.well-known/oauth-authorization-server",
        destination: "/api/well-known/oauth-authorization-server",
      },
    ];
  },
};

export default config;
