// Its own module so a test can load it: PrintActions.tsx pulls in UI5, which needs a window.

/** An oRPC error code (b1.ts toOrpcError) -> the sentence a user reads. BAD_REQUEST is SAP refusing
 *  the export (the engine's own 400), like BAD_GATEWAY; PRECONDITION_FAILED is the document's default
 *  layout not being a Crystal one (print.ts) — fixed in SAP, never by trying again. */
const ERROR_TEXT: Record<string, string> = {
  SERVICE_UNAVAILABLE: "UI_PREVIEW_ERR_UNAVAILABLE",
  BAD_GATEWAY: "UI_PREVIEW_ERR_SAP",
  BAD_REQUEST: "UI_PREVIEW_ERR_SAP",
  PRECONDITION_FAILED: "UI_PREVIEW_ERR_SAP",
  NOT_FOUND: "UI_PREVIEW_ERR_NOT_FOUND",
  CONFLICT: "UI_PREVIEW_ERR_CONFLICT",
  FORBIDDEN: "UI_PREVIEW_ERR_FORBIDDEN",
};

export const printErrorText = (code: string): string => ERROR_TEXT[code] ?? "UI_PREVIEW_ERR_OTHER";
