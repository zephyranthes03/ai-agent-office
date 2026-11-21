// JSON Schema validation of what reaches the daemon: hook envelopes, standard events and the
// config file, against the published schemas. Error texts name the failing path and rule only
// (ajv never quotes the value), so they are safe to log.
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import configSchema from "../../../schemas/config.schema.json" with { type: "json" };
import eventSchema from "../../../schemas/event.schema.json" with { type: "json" };
import envelopeSchema from "../../../schemas/hook-envelope.schema.json" with { type: "json" };

// ajv-formats is CommonJS; its module object is the plugin function itself.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export type Validate = (value: unknown) => string[];
export type Validators = { envelope: Validate; event: Validate; config: Validate };

export function createValidators(): Validators {
  const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const make = (schema: object): Validate => {
    const fn = ajv.compile(schema);
    return (value) => (fn(value) ? [] : (fn.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`));
  };
  return { envelope: make(envelopeSchema), event: make(eventSchema), config: make(configSchema) };
}
