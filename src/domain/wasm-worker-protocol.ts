/**
 * Message protocol between the main thread and the WASM parse worker.
 *
 * The worker owns every tree-sitter WASM call. Fatal V8 aborts from the
 * grammar (#965) kill only the worker — the main thread respawns it and
 * skips the file that crashed.
 *
 * The worker returns fully pre-computed ExtractorOutput — matching what the
 * native engine's parseFilesFull emits — so the main thread never holds a
 * live Tree. The `_tree` field is never populated by this pipeline.
 */

import type {
  Call,
  ClassRelation,
  DataflowResult,
  Definition,
  Export,
  Import,
  LanguageId,
  TypeMapEntry,
} from '../types.js';

export interface WorkerAnalysisOpts {
  ast: boolean;
  complexity: boolean;
  cfg: boolean;
  dataflow: boolean;
}

export interface WorkerParseRequest {
  type: 'parse';
  id: number;
  filePath: string;
  code: string;
  opts: WorkerAnalysisOpts;
}

export interface WorkerShutdownRequest {
  type: 'shutdown';
}

export type WorkerRequest = WorkerParseRequest | WorkerShutdownRequest;

/**
 * Serialized ExtractorOutput shape. Identical to ExtractorOutput except:
 *  - `_tree` is never set (cannot cross worker boundary).
 *  - `typeMap` is encoded as an array of [key, value] tuples. Structured
 *    clone supports Map natively in Node 22, but the tuple form keeps the
 *    wire format language-agnostic and matches the native engine's form.
 */
export interface SerializedExtractorOutput {
  definitions: Definition[];
  calls: Call[];
  imports: Import[];
  classes: ClassRelation[];
  exports: Export[];
  typeMap: Array<[string, TypeMapEntry]>;
  _langId?: LanguageId;
  _lineCount?: number;
  dataflow?: DataflowResult;
  astNodes?: Array<{
    line: number;
    kind: string;
    name: string;
    text?: string;
    receiver?: string;
  }>;
}

export interface WorkerParseResponseOk {
  type: 'result';
  id: number;
  ok: true;
  result: SerializedExtractorOutput | null;
}

export interface WorkerParseResponseErr {
  type: 'result';
  id: number;
  ok: false;
  error: string;
}

export type WorkerResponse = WorkerParseResponseOk | WorkerParseResponseErr;
