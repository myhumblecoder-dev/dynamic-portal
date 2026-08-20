import { afterEach, describe, expect, it } from "vitest";
import * as agent from "./agent";
import { describeModel, isAgentEnabled, resolveModel } from "./model";

/**
 * What the hub says it will talk to, and what it will actually talk to.
 *
 * These exist because the answer was invisible from outside the process and I
 * got it wrong twice — reporting a local model while the container was billing
 * the hosted one. A line that says the wrong thing is worse than no line,
 * because it ends the question.
 *
 * So the assertions are about disagreement rather than about wording: that the
 * line and `isAgentEnabled()` never disagree about whether anything will
 * answer, and that the defaults `resolveModel()` fills in are the ones the
 * clients would have chosen for themselves.
 */

const KEYS = [
  "PORTAL_AGENT",
  "PORTAL_AGENT_DISABLED_TENANTS",
  "PORTAL_MODEL_PROVIDER",
  "PORTAL_ANTHROPIC_MODEL",
  "PORTAL_OLLAMA_MODEL",
  "PORTAL_OLLAMA_URL",
  "ANTHROPIC_API_KEY",
] as const;
const saved = new Map(KEYS.map((key) => [key, process.env[key]]));

/**
 * A key by default, because most of these are about the model rather than
 * about the gate, and the developer running them may or may not have one
 * exported. Without this the suite passes or fails on whose shell it is.
 */
function configured(): void {
  for (const key of KEYS) delete process.env[key];
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-not-a-real-key";
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("which model will answer", () => {
  it("is the hosted one when nothing else is configured", () => {
    configured();
    expect(resolveModel()).toMatchObject({ provider: "anthropic" });
    expect(describeModel()).toMatch(/metered/i);
  });

  it("treats an empty variable as unset, because compose writes one", () => {
    // `VAR: ${VAR:-}` yields "" rather than undefined, and this reading it as
    // a provider is what once sent an empty model name to Ollama.
    configured();
    process.env["PORTAL_MODEL_PROVIDER"] = "";
    expect(resolveModel().provider).toBe("anthropic");
  });

  it("is the local one when asked for, and says it costs nothing", () => {
    configured();
    process.env["PORTAL_MODEL_PROVIDER"] = "ollama";
    expect(resolveModel()).toMatchObject({ provider: "ollama" });
    expect(describeModel()).toMatch(/no API cost/i);
  });

  it("names the model and where it lives, not just the provider", () => {
    // "local" alone would not have caught the empty-model-name bug.
    configured();
    process.env["PORTAL_MODEL_PROVIDER"] = "ollama";
    process.env["PORTAL_OLLAMA_MODEL"] = "llama3.1:8b";
    process.env["PORTAL_OLLAMA_URL"] = "http://elsewhere:11434";

    expect(describeModel()).toContain("llama3.1:8b");
    expect(describeModel()).toContain("http://elsewhere:11434");
  });

  it("falls back to real defaults when the local settings arrive empty", () => {
    // The actual bug the `set()` helper exists for, which testing an empty
    // *provider* does not reach: compose writes `PORTAL_OLLAMA_MODEL: ${VAR:-}`
    // and an unconfigured stack passes "" through to the client, which asked
    // Ollama for a model with no name.
    configured();
    process.env["PORTAL_MODEL_PROVIDER"] = "ollama";
    process.env["PORTAL_OLLAMA_MODEL"] = "";
    process.env["PORTAL_OLLAMA_URL"] = "";

    const resolved = resolveModel();
    expect(resolved).toMatchObject({ provider: "ollama" });
    expect(resolved.provider === "ollama" && resolved.baseUrl).toBeTruthy();
    expect(resolved.model).not.toBe("");
  });

  it("refuses a provider nobody recognises rather than billing", () => {
    // The failure this whole feature exists to prevent: asking for a free
    // model, getting a metered one, and learning from the invoice.
    configured();
    process.env["PORTAL_MODEL_PROVIDER"] = "ollma";
    expect(() => resolveModel()).toThrow(/is not a provider/);
    expect(() => describeModel()).toThrow(/is not a provider/);
  });

  it("never calls the hosted model free, whatever else is set", () => {
    // The specific sentence that would mislead someone reading a log.
    configured();
    expect(describeModel()).not.toMatch(/no API cost/i);
  });
});

describe("the line and the gate", () => {
  /**
   * The claim the line is worth having for. `isAgentEnabled()` is what the
   * route answers 404 from; if the line can say a model is answering while
   * that is false, the line is an authoritative-looking lie and the reader
   * stops looking.
   */
  const gates = [
    { name: "nothing configured at all", env: {} },
    { name: "the hosted provider with a key", env: { ANTHROPIC_API_KEY: "sk-ant-x" } },
    { name: "the local provider with no key", env: { PORTAL_MODEL_PROVIDER: "ollama" } },
    {
      name: "the local provider with a key",
      env: { PORTAL_MODEL_PROVIDER: "ollama", ANTHROPIC_API_KEY: "sk-ant-x" },
    },
    { name: "the kill switch", env: { PORTAL_AGENT: "off", ANTHROPIC_API_KEY: "sk-ant-x" } },
    {
      name: "the kill switch with the local provider",
      env: { PORTAL_AGENT: "off", PORTAL_MODEL_PROVIDER: "ollama" },
    },
  ] as const;

  for (const { name, env } of gates) {
    it(`agree with ${name}`, () => {
      for (const key of KEYS) delete process.env[key];
      for (const [key, value] of Object.entries(env)) process.env[key] = value;

      const saysOff = describeModel().includes("assistant: off");
      expect(saysOff).toBe(!isAgentEnabled());
    });
  }

  it("says the assistant is off, not that it is billing, with no key", () => {
    // The default compose stack: `ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}`
    // with no root `.env`. Resolution says "the hosted model"; the gate says
    // 404. Reporting the resolution printed "every turn is billed" on the one
    // configuration that bills nothing.
    for (const key of KEYS) delete process.env[key];

    expect(isAgentEnabled()).toBe(false);
    expect(describeModel()).toMatch(/^assistant: off/);
    expect(describeModel()).toMatch(/ANTHROPIC_API_KEY/);
    expect(describeModel()).not.toMatch(/billed/i);
  });

  it("names the switch that turned it off, so the line is actionable", () => {
    for (const key of KEYS) delete process.env[key];
    process.env["PORTAL_AGENT"] = "off";
    expect(describeModel()).toBe("assistant: off (PORTAL_AGENT=off)");
  });
});

describe("the split from agent.ts", () => {
  it("re-exports the gate, so the routes keep importing one module", () => {
    // `./model` exists to stay free of node builtins for the edge
    // instrumentation bundle. `layout.tsx` and `api/agent/route.ts` import the
    // gate from `./agent`, and a re-export that quietly stopped covering one
    // of these would hide the assistant rather than fail.
    expect(agent.isAgentEnabled).toBe(isAgentEnabled);
    expect(agent.describeModel).toBe(describeModel);
    expect(agent.resolveModel).toBe(resolveModel);
  });
});

describe("what the line is allowed to print", () => {
  it("counts tenants that have opted out without naming them", () => {
    // A startup line is pasted into issues and CI logs. That some tenants are
    // excluded is the operator's fact; which customers they are is not.
    configured();
    process.env["PORTAL_AGENT_DISABLED_TENANTS"] = "acme-health,northwind";

    const line = describeModel();
    expect(line).toContain("2 tenants");
    expect(line).not.toContain("acme-health");
    expect(line).not.toContain("northwind");
  });

  it("says nothing about tenants when none have opted out", () => {
    configured();
    expect(describeModel()).not.toMatch(/tenant/i);
  });

  it("prints no key material", () => {
    configured();
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-api03-secret-value";
    expect(describeModel()).not.toContain("sk-ant");
    expect(describeModel()).not.toContain("secret-value");
  });

  it("strips credentials someone tunnelled through the ollama URL", () => {
    // Not hypothetical enough to ignore: reaching a shared GPU box through a
    // proxy is how a password ends up in a URL, and this line is copied around.
    configured();
    process.env["PORTAL_MODEL_PROVIDER"] = "ollama";
    process.env["PORTAL_OLLAMA_URL"] = "http://ops:hunter2@gpu-box:11434";

    const line = describeModel();
    expect(line).not.toContain("hunter2");
    expect(line).toContain("gpu-box:11434");
  });
});

/**
 * Which Anthropic model, when Anthropic is the provider.
 *
 * The local model has been overridable since it was added and this one was
 * not, for no reason anybody chose — so a deployment that wanted a cheaper
 * model had to edit `packages/agent` and rebuild. The difference between
 * `claude-opus-5` and `claude-haiku-4-5` is a factor of five on input and
 * output both, which is a decision a person makes per deployment, not one a
 * constant makes for them.
 */
describe("choosing the Anthropic model", () => {
  it("defaults to the model the plan picked", () => {
    configured();
    delete process.env["PORTAL_MODEL_PROVIDER"];

    expect(describeModel()).toContain("claude-opus-5");
  });

  it("uses the one the deployment names", () => {
    configured();
    delete process.env["PORTAL_MODEL_PROVIDER"];
    process.env["PORTAL_ANTHROPIC_MODEL"] = "claude-haiku-4-5";

    expect(describeModel()).toContain("claude-haiku-4-5");
    // Still metered — a cheaper model is not a free one, and the startup line
    // is the only place anyone is told which it is.
    expect(describeModel()).toContain("metered");
  });

  it("ignores the setting when the provider is local", () => {
    configured();
    process.env["PORTAL_MODEL_PROVIDER"] = "ollama";
    process.env["PORTAL_ANTHROPIC_MODEL"] = "claude-haiku-4-5";

    expect(describeModel()).not.toContain("claude-haiku-4-5");
    expect(describeModel()).toContain("no API cost");
  });

  it("treats an empty or blank value as unset", () => {
    // `PORTAL_ANTHROPIC_MODEL=` in a compose file is how a passthrough looks
    // when the variable is not set on the host, and an empty model name would
    // reach the API as a 404 nobody could read.
    configured();
    delete process.env["PORTAL_MODEL_PROVIDER"];
    process.env["PORTAL_ANTHROPIC_MODEL"] = "   ";

    expect(describeModel()).toContain("claude-opus-5");
  });
});
