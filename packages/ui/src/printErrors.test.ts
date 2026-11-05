import { expect, test } from "bun:test";
import { printErrorText } from "./printErrors.ts";

// The sentence a failed print shows comes from the error's code. A refusal that a retry cannot fix
// (the document's default layout is not Crystal: PRECONDITION_FAILED) points at the layout in SAP,
// never at "try again in a moment".
test("a print refused for its layout points at the layout, not at a retry", () => {
  expect(printErrorText("PRECONDITION_FAILED")).toBe("UI_PREVIEW_ERR_SAP");
  expect(printErrorText("BAD_REQUEST")).toBe("UI_PREVIEW_ERR_SAP");
  expect(printErrorText("SOMETHING_ELSE")).toBe("UI_PREVIEW_ERR_OTHER");
});
