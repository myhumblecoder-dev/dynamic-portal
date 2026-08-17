import type { ExtractedData } from "@portal/mcp-gateway";
import { checkArguments } from "@portal/mcp-gateway";
import type { ActionResponse } from "@portal/protocol";
import type { PublicOperationParam, PublicResourceParam } from "./catalog";

/**
 * What an external client actually receives.
 *
 * Not a UI tree, and not the gateway's extraction shape either. Both are ours
 * to change; this is not. A partner integrating against `collections` and
 * `summary` should be unaffected by a satellite reorganising a screen, which is
 * the whole reason the internal vocabulary stays evolvable.
 *
 * The extraction step is shared with the agent path deliberately — "the data on
 * this screen, without the layout" is one question with one right answer, and
 * two implementations of it would drift on exactly the fields that matter.
 */

export interface PublicColumn {
  readonly key: string;
  readonly label: string;
}

export interface PublicCollection {
  readonly name?: string;
  readonly columns: readonly PublicColumn[];
  readonly records: readonly Record<string, unknown>[];
  /** How many the screen held, before any cap. */
  readonly recordCount: number;
  readonly truncated: boolean;
}

export interface PublicResourceResponse {
  readonly service: string;
  readonly resource: string;
  /**
   * The screen's own title.
   *
   * Carried because a detail resource may be nothing but a summary — a list of
   * labelled values with no field identifying *which* record they belong to,
   * since the screen said that in its heading. Dropping it left a response that
   * was correct and unusable.
   */
  readonly title: string;
  readonly collections: readonly PublicCollection[];
  readonly summary: readonly { readonly label: string; readonly value: string }[];
  readonly notes: readonly string[];
}

export interface PublicOperationResponse {
  readonly service: string;
  readonly operation: string;
  readonly outcome: ActionResponse["outcome"];
  readonly message?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

/**
 * Several collections rather than one guessed primary.
 *
 * A screen may hold two tables, and picking one to call "the" records would be
 * right until the day a satellite adds a second — at which point every client
 * silently starts reading a different table.
 */
export function projectResource(
  service: string,
  resource: string,
  title: string,
  data: ExtractedData,
): PublicResourceResponse {
  return {
    service,
    resource,
    title,
    collections: data.tables.map((table) => ({
      ...(table.id === undefined ? {} : { name: table.id }),
      columns: table.columns.map((column) => ({ key: column.key, label: column.label })),
      records: table.rows,
      recordCount: table.rowCount,
      truncated: table.truncated,
    })),
    // Stat tiles and key-value pairs are the same thing to a client reading
    // JSON: a labelled figure. The distinction between them is a layout one.
    summary: [
      ...data.stats.map((stat) => ({ label: stat.label, value: stat.value })),
      ...data.facts.map((fact) => ({ label: fact.label, value: fact.value })),
    ],
    notes: data.text,
  };
}

export function projectOperation(
  service: string,
  operation: string,
  envelope: ActionResponse,
): PublicOperationResponse {
  return {
    service,
    operation,
    outcome: envelope.outcome,
    // The satellite's own toast text, which is written for a person and serves
    // a client just as well. Nothing else from the envelope crosses: `patch`
    // and `navigate` are instructions to a renderer this client does not have.
    ...(envelope.toast === undefined ? {} : { message: envelope.toast.message }),
    ...(envelope.fieldErrors === undefined ? {} : { fieldErrors: envelope.fieldErrors }),
  };
}

export type ArgumentCheck =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/**
 * The same check the gateway runs on a tool call, against the same shape.
 *
 * A public parameter list and a tool's input schema describe the same thing, so
 * they are checked by the same function rather than by two that agree until one
 * of them is fixed.
 */
export function checkResourceParams(
  params: readonly PublicResourceParam[],
  query: Readonly<Record<string, unknown>>,
): ArgumentCheck {
  return checkArguments(
    {
      type: "object",
      properties: Object.fromEntries(params.map((param) => [param.name, { type: "string" as const }])),
      required: params.filter((param) => param.required).map((param) => param.name),
      additionalProperties: false,
    },
    query,
    "read",
    // A partner has never heard of a tool; the word for this thing out here is
    // "resource", and the message is part of the published contract.
    "resource",
  );
}

export function checkOperationParams(
  params: readonly PublicOperationParam[],
  body: Readonly<Record<string, unknown>>,
): ArgumentCheck {
  return checkArguments(
    {
      type: "object",
      properties: Object.fromEntries(
        params.map((param) => [
          param.name,
          { type: param.type, ...(param.enum === undefined ? {} : { enum: param.enum }) },
        ]),
      ),
      required: params.filter((param) => param.required).map((param) => param.name),
      additionalProperties: false,
    },
    body,
    "write",
    "operation",
  );
}
