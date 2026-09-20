I want to rewrite from scratch the lookups system.

Master data which is query type will be cached on config_masterdata to avoid long SAP B1 Service Layer query times. User will define sync frequency for the query master data. Configurator runtime will use the stored data and if not available will trigger the sync. User will have a button on ConfigProcessPage.tsx to trigger sync manually too on the Toolbar.

I also want to decouple the runtime data from the query data so it can render all the possible things without depending on the SAP B1 data. Currently if query fails the runtime is not able to render anything. Also, the rest of the information can be obtained direcly from the model definition: bom, routing, parameters, sections, etc all can be obtained from the model.

ValueHelp.tsx should use the cached master data instead of querying it live in the configuration process too.

Config history is now based on a masterdata query too, so drop all the current related code and include it in the same circuit, where its stored on masterdata table. Simplifying everything.

If you think that the volume of data will be too much, consider using a subtable for the data caching storage.

Cleanup all the code and aim for simplification. If any doubt please ask before asuming anything


