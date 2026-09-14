import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageTitle, Icon, IllustratedMessage, Input,
  List, ListItemCustom, MessageStrip, Option, Select, Tag, Title, ToggleButton, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { orpc } from "../../../orpc.ts";

export const Route = createFileRoute("/_authed/b1/")({ component: Entities });

// What SAP exposes, browsable. The categories come from the ported B1 mapping; anything B1 adds
// later that the mapping has not heard of falls into "other" rather than disappearing.
function Entities() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");

  const list = useQuery({ ...orpc.entities.list.queryOptions({ input: {} }), retry: false, staleTime: 5 * 60_000 });
  const pinsOpts = orpc.entities.navPins.queryOptions();
  const pins = useQuery(pinsOpts);
  const setPin = useMutation(orpc.entities.setNavPin.mutationOptions({
    onSuccess: () => qc.invalidateQueries({ queryKey: pinsOpts.queryKey }),
  }));
  const pinned = useMemo(() => new Set((pins.data?.entities ?? []).map((p) => p.name)), [pins.data]);

  const entities = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (list.data?.entities ?? [])
      .filter((e) => !category || e.categories.includes(category))
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.label.toLowerCase().includes(q) || e.table.toLowerCase().includes(q));
  }, [list.data, category, search]);

  return (
    <DynamicPage
      titleArea={
        <DynamicPageTitle
          heading={<Title>Entities</Title>}
          subheading={list.data ? <span>{`${entities.length} entity sets`}</span> : undefined}
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarButton icon="refresh" text="Refresh SAP schema" disabled={list.isFetching}
                onClick={() => { void list.refetch(); }} />
            </Toolbar>
          }
        />
      }>
      <div style={{ display: "flex", gap: "0.75rem", padding: "0 0 0.75rem", flexWrap: "wrap" }}>
        <Input type="Search" icon={<Icon name="search" />} placeholder="Search entity sets" showClearIcon
          accessibleName="Search entity sets"
          value={search} onInput={(e) => setSearch(e.target.value ?? "")} style={{ minWidth: "18rem" }} />
        <Select accessibleName="Business area" value={category}
          onChange={(e) => setCategory(e.detail.selectedOption.value ?? "")}>
          <Option value="">All areas</Option>
          {(list.data?.categories ?? []).map((c) => (
            <Option key={c} value={c}>{c}</Option>
          ))}
        </Select>
      </div>

      {list.error ? <MessageStrip design="Negative" hideCloseButton>{list.error.message}</MessageStrip> : null}

      {list.data && !entities.length ? (
        <IllustratedMessage name="NoEntries" design="Auto" titleText="Nothing matches"
          subtitleText="Try another business area or a different search term." />
      ) : null}

      <List
        accessibleName="Entity sets"
        loading={list.isFetching}
        loadingDelay={0}
        onItemClick={(e) => {
          const entity = (e.detail.item as HTMLElement).dataset.entity;
          if (entity) void navigate({ to: "/b1/$entity", params: { entity } });
        }}>
        {entities.map((e) => {
          const on = pinned.has(e.name);
          return (
            <ListItemCustom key={e.name} data-entity={e.name}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", width: "100%" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span>{e.label}</span>
                    {e.entityClass !== "standard" ? <Tag design="Set2">{e.entityClass.toUpperCase()}</Tag> : null}
                  </div>
                  <div style={{ opacity: 0.7, fontSize: "0.875rem" }}>{e.name}</div>
                </div>
                <span style={{ opacity: 0.7 }}>{e.table}</span>
                <ToggleButton
                  icon="pushpin-off"
                  pressed={on}
                  tooltip={on ? "Remove from menu" : "Add to menu"}
                  onClick={() => setPin.mutate({ name: e.name, label: e.label, pinned: !on })}
                />
              </div>
            </ListItemCustom>
          );
        })}
      </List>
    </DynamicPage>
  );
}
