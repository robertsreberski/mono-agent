import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** Node <24.16 truncates TEXT results at NUL (nodejs/node#61954). Only
 * explicitly BLOB-cast free-text projections use this reader; JSON.stringify
 * already escapes NUL and identifiers/status fields are not prose. */
export function sqliteTextQuery(database: DatabaseSync, sql: string) {
  const statement = database.prepare(sql);
  const decode = (row: Record<string, unknown>) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8") : value]),
  );
  return {
    get(...parameters: SQLInputValue[]) {
      const row = statement.get(...parameters);
      return row === undefined ? undefined : decode(row);
    },
    all(...parameters: SQLInputValue[]) { return statement.all(...parameters).map(decode); },
  };
}

// Explicit projections keep bodies from being selected twice through table.*.
const columns = {
  process_job_cards: "source_id,job_id,delivery_key,thread_id,message_id,projection_sha256,response_text,created_at,updated_at,state,completed_at",
  projects: "color,id,source_id,name,context,created_at,updated_at,archived_at,revision",
  live_inputs: "id,thread_id,message_id,active_turn_id,text,model,effort,status,dispatch_started_at,created_at,updated_at,context_1m",
  cron_reply_operations: "operation_id,source_id,job_id,run_id,thread_id,conversation_id,provenance_message_id,result_message_id,idempotency_key,state,snapshot_kind,snapshot_text,snapshot_sha256,title,run_model,run_effort,canonical_status,failure_reason,created_at,completed_at,failed_at,tombstoned_at,run_context_1m",
  restart_operations: "id,source_id,generation,operation_id,requested_at,deadline,stage,outcome,reason,uncertain,approximate_running_turns",
  turns: "id,thread_id,status,text,model,effort,requested_model,requested_effort,effective_effort,routing_json,assistant_message_id,started_at,finished_at,error_code,error_message,project_context_json,cancel_origin,conversation_markers_json,dispatch_started_at,dispatch_generation,web_recovery_generation_confirmed_at,reply_disposition,context_1m",
  agents: "source_id,label,status,discovered,health,supports_attachments,supports_provider_auth,models_json,default_model,default_effort,efforts_json,model_options_json,providers_json,cron_read,cron_actions,ask_by_id,updated_at",
} as const;
const prose: Record<keyof typeof columns, readonly string[]> = {
  process_job_cards: ["response_text"],
  projects: ["name", "context"],
  live_inputs: ["text"],
  cron_reply_operations: ["failure_reason"],
  restart_operations: ["reason"],
  turns: ["text", "error_message"],
  agents: ["label", "health"],
};

export function webTextColumns(table: keyof typeof columns, alias?: string): string {
  return columns[table].split(",").map(column => {
    const name = alias === undefined ? column : `${alias}.${column}`;
    return prose[table].includes(column) ? `CAST(${name} AS BLOB) AS ${column}` : name;
  }).join(", ");
}
