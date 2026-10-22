import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Link, Option, Select } from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";

// A model names a tenant masterdata query and never holds the query itself, so every "which
// query?" field in the builder is this same Select plus a way to go look at the thing it names.
// Two of them now — the history source and the BOM's item/price source — which is what pulled it
// out of HistoryTab.
//
// Its own useQuery: TanStack dedupes by key, so N of these on a page still cost one fetch.

export function MasterdataQuerySelect({ value, onChange, issue, required, accessibleName }: {
  value: string | undefined;
  onChange: (name: string | undefined) => void;
  issue?: string;
  required?: boolean;
  accessibleName: string;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const md = useQuery(orpc.masterdata.list.queryOptions());
  const queries = (md.data ?? []).filter((t) => t.kind === "query");
  const picked = queries.find((t) => t.name === value);
  const empty = !queries.length;

  return (
    <>
      <Select value={value ?? ""} accessibleName={accessibleName}
        valueState={issue ? "Negative" : empty ? "Information" : "None"}
        valueStateMessage={<div>{issue ?? (empty ? t("MODEL_NO_QUERIES") : t("MODEL_CHOOSE_QUERY"))}</div>}
        onChange={(e) => onChange(e.detail.selectedOption.value || undefined)}>
        <Option value="">{empty ? t("MODEL_NONE_DEFINED") : required ? t("MODEL_PICK_ONE") : t("MODEL_NONE")}</Option>
        {queries.map((q) => (
          <Option key={q.id} value={q.name} additionalText={q.query?.query.entitySet}>{q.name}</Option>
        ))}
      </Select>
      {picked ? (
        <Link icon="inspect" wrappingType="None"
          onClick={() => void navigate({ to: "/$slug/masterdata/$id", params: { id: picked.id } })}>
          {t("MODEL_OPEN_MD")}
        </Link>
      ) : (
        <Link icon="add" wrappingType="None" onClick={() => void navigate({ to: "/$slug/masterdata/new" })}>
          {t("MODEL_CREATE_QUERY")}
        </Link>
      )}
    </>
  );
}
