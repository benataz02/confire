// Ported from b1-mcp-server's src/tools/b1-category-mappings.ts (SAP's sample, MIT — notice below),
// data only. Its `workflow` entry named the sample's own tools, not entity sets, and is dropped; its
// two user-defined categories are computed from the entity's class (`categoriesOf`), as it describes.
// The map is B1 10.0 FP2608's; it is the one way `b1.find` finds a standard entity on a Service
// Layer too old to carry labels.
//
// MIT License — Copyright (c) 2026 (b1-mcp-server)
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { B1EntityRef } from "./metadata.ts";

export const B1_CATEGORIES: Record<string, string[]> = {
    // ====================================================================================
    // SALES & CUSTOMER RELATIONSHIPS
    // ====================================================================================
    "sales": [
        // Core sales documents
        "Quotations",
        "Orders",
        "DeliveryNotes",
        "Returns",
        "ReturnRequest",
        "Invoices",
        "CreditNotes",
        "DownPayments",
        "CorrectionInvoice",
        "CorrectionInvoiceReversal",
        "Drafts",

        // Sales opportunities and activities
        "SalesOpportunities",
        "SalesOpportunitySourcesSetup",
        "SalesOpportunityInterestsSetup",
        "Activities",
        "ActivityLocations",
        "ActivityStatuses",
        "ActivityRecipientLists",
        "BlanketAgreements",

        // Sales configuration
        "SalesPersons",
        "Territories",
        "SpecialPrices",
        "EnhancedDiscountGroups",
        "Campaigns",
        "SalesForecast",
        "CommissionGroups",
        "TargetGroups",
        "SalesStages",
    ],

    // ====================================================================================
    // PURCHASE & VENDOR MANAGEMENT
    // ====================================================================================
    "purchase": [
        // Core purchasing documents
        "PurchaseQuotations",
        "PurchaseOrders",
        "PurchaseDeliveryNotes",
        "PurchaseReturns",
        "PurchaseInvoices",
        "PurchaseCreditNotes",
        "GoodsReturnRequest",
        "PurchaseDownPayments",
        "PurchaseRequests",
        "CorrectionPurchaseInvoice",
        "CorrectionPurchaseInvoiceReversal",
        "Drafts",

        // Vendor management & pricing
        "BlanketAgreements",
        "CustomsGroups",
        "CustomsDeclaration",
        "LandedCosts",
        "LandedCostsCodes",
        "AdditionalExpenses",
    ],

    // ====================================================================================
    // BANKING & PAYMENTS
    // ====================================================================================
    "banking": [
        // Bank accounts & statements
        "BankStatements",
        "BankPages",
        "HouseBankAccounts",
        "ChecksforPayment",
        "BankChargesAllocationCodes",
        "PaymentBlocks",
        "CentralBankIndicator",

        // Payments
        "IncomingPayments",
        "VendorPayments",
        "PaymentDrafts",
        "PaymentRunExport",
        "BillOfExchangeTransactions",

        // Payment methods & configuration
        "Banks",
        "PaymentWizards",
        "CreditPaymentMethods",
        "CreditCardPayments",
        "CreditCards",
        "ChecksforPayment",
        "PaymentBlocks",
        "PaymentReasonCodes",
        "WizardPaymentMethods",
        "Deposits",

        // Cash flow
        "CashFlowLineItems",
    ],

    // ====================================================================================
    // FINANCE & ACCOUNTING
    // ====================================================================================
    "finance": [
        // Accounts Receivable (AR)
        "IncomingPayments",

        // Accounts Payable (AP)
        "VendorPayments",

        // General Ledger & Journals
        "JournalEntries",
        "ChartOfAccounts",
        "GLAccountAdvancedRules",
        "JournalEntryDocumentTypes",
        "InternalReconciliations",

        // Budgeting & Forecasting
        "Budgets",
        "BudgetScenarios",
        "DistributionRules",
        "ProfitCenters",
        "DistributionRules",
        "CostElements",

        // Projects
        "Projects",
        "ProjectManagements",
        "ProjectManagementTimeSheet",

        // Fixed Assets
        "AssetClasses",
        "DepreciationAreas",
        "DepreciationTypes",
        "DepreciationTypePools",
        "AssetDepreciationGroups",
        "AssetGroups",
        "AssetManualDepreciation",
        "AssetCapitalization",
        "AssetCapitalizationCreditMemo",
        "AssetTransfer",
        "AssetRetirement",
        "AssetRevaluations",
        "AttributeGroups",
        "FAAccountDeterminations",

        // Accounting Setup & Configuration
        "ClosingDateProcedure",
        "Currencies",
        "PaymentTermsTypes",
        "WithholdingTaxCodes",
        "WTaxTypeCodes",
        "VatGroups",
        "SalesTaxCodes",
        "SalesTaxAuthorities",
        "DunningTerms",
        "DunningLetters",
        "DeductibleTaxes",
        "CashDiscounts",
        "FinancialYears",
        "AccountSegmentations",
        "AccountSegmentationCategories",
        "FactoringIndicators",
        "AccrualTypes",
        "CostCenterTypes",
        "BudgetDistributions",
        "AccountCategory",
        "BOEDocumentTypes",
        "BOEInstructions",
        "BOEPortfolios",
        "OccurrenceCodes",
        "PostingTemplates",
        "RecurringTransactionTemplates",
        "RecurringPostings",
        "DeterminationCriterias",
        "ExpenseTypes",
        "TaxCodeDeterminations",
        "TransactionCodes",
    ],

    // ====================================================================================
    // INVENTORY & WAREHOUSE MANAGEMENT
    // ====================================================================================
    "inventory": [
        // Master data
        "Items",
        "ItemGroups",
        "ItemProperties",
        "Warehouses",
        "BinLocations",
        "BinLocationAttributes",
        "UnitOfMeasurements",
        "UnitOfMeasurementGroups",
        "BarCodes",
        "AlternateCatNum",
        "PackagesTypes",
        "SerialNumberDetails",
        "BatchNumberDetails",
        "MaterialGroups",
        "ItemImages",
        "InventoryCycles",
        "LengthMeasures",
        "WeightMeasures",

        // Inventory transactions
        "StockTransfers",
        "StockTransferDrafts",
        "StockTakings",
        "InventoryTransferRequests",
        "InventoryGenEntries",
        "InventoryGenExits",
        "InventoryPostings",
        "MaterialRevaluation",
        "InventoryCountings",
        "InventoryCountingDrafts",
        "CycleCountDeterminations",
        "PickLists",

        // Logistics & shipping
        "DeliveryNotes",
        "Returns",
        "ReturnRequest",
        "ShippingTypes",
        "TransportationDocument",
        "RouteStages",
        "EWBTransporters",

        // Warehouse management
        "WarehouseLocations",
        "TrackingNotes",

        // Details & dimensions
        "WarehouseSublevelCodes",
        "BinLocationFields",
        "InventoryOpeningBalances",
    ],

    // ====================================================================================
    // PRODUCTION & MANUFACTURING
    // ====================================================================================
    "production": [
        "Manufacturers",
        "ProductionOrders",
        "ProductTrees",
        "Resources",
        "ResourceGroups",
        "ResourceProperties",
        "MRPScenarios",
        "ResourceCapacities",
    ],

    // ====================================================================================
    // BUSINESS PARTNER & CUSTOMER MANAGEMENT
    // ====================================================================================
    "business-partner": [
        // Core business partner data
        "BusinessPartners",
        "BusinessPartnerGroups",
        "BPVatExemptions",

        // Contact & communication
        "Contacts",
        "Relationships",
        "ActivityRecipientLists",

        // Classification & segmentation
        "SalesPersons",
        "Territories",
        "Industries",
        "Countries",
        "States",
        "BPPriorities",
        "BusinessPartnerProperties",
        "PartnersSetups",
    ],

    // ====================================================================================
    // HUMAN RESOURCES & ORGANIZATION
    // ====================================================================================
    "hr": [
        // Employee & organization structure
        "EmployeesInfo",
        "EmployeeRolesSetup",
        "EmployeePosition",
        "EmployeeIDType",
        "Teams",
        "Departments",
        "Branches",
        "UserDefaultGroups",
        "ProfitCenters",
        "Genders",
        "Holidays",

        // Time management
        "ProjectManagementTimeSheet",

        // Expenses & benefits
        "EmploymentCategorys",
        "EmployeeStatus",
        "TerminationReason",
        "EmployeeTransfers",
        "EmployeeImages",
    ],

    // ====================================================================================
    // SERVICE & TECHNICAL SUPPORT
    // ====================================================================================
    "service": [
        // Service calls & tickets
        "ServiceCalls",
        "ServiceCallSolutionStatus",
        "ServiceCallProblemTypes",
        "ServiceCallProblemSubTypes",
        "ServiceCallStatus",
        "ServiceCallTypes",
        "ServiceCallOrigins",

        // Service contracts
        "ServiceContracts",
        "ContractTemplates",

        // Equipment tracking
        "CustomerEquipmentCards",
        "KnowledgeBaseSolutions",
        "ServiceGroups",
    ],

    // ====================================================================================
    // MASTER DATA & CORE REFERENCE
    // ====================================================================================
    "master-data": [
        // Items & products
        "Items",
        "ItemGroups",
        "ItemProperties",
        "BarCodes",
        "AlternateCatNum",
        "IdentificationCodes",

        // Business partners
        "BusinessPartners",
        "BusinessPartnerGroups",

        // Warehouses & locations
        "Warehouses",
        "BinLocations",
        "BusinessPlaces",
        "Counties",

        // Financials
        "ChartOfAccounts",
        "ProfitCenters",
        "Projects",
        "Currencies",
        "ExchangeRates",
        "Countries",
        "States",
        "UserLanguages",

        // Commercial
        "PaymentTermsTypes",
        "PriceLists",
        "SpecialPrices",

        // Shipping & packaging
        "ShippingTypes",
        "PackagesTypes",
        "CarrierTypes",
        "TransportationDocument",

        // Taxation
        "WithholdingTaxCodes",
        "SalesTaxCodes",
        "VatGroups",
        "SalesTaxAuthorities",
        "WTaxTypeCodes",
        "PaymentReasonCodes",

        // Reference values
        "Series",
        "NumberingSeries",
        "CertificateSeries",
        "Dimensions",
        "LocalEra",
        "IdentificationCodes",
        "Pictures",
    ],

    // ====================================================================================
    // CUSTOMIZATION & EXTENSIONS
    // ====================================================================================
    "customization": [
        // User-defined fields & tables
        "UserFieldsMD",
        "UserTablesMD",
        "UserObjectsMD",

        // Custom data structures
        "UserFields",
        "UserQueries",
        "QueryCategories",
        "QueryAuthGroups",
        "UserKeysMD",
        "FormattedSearches",

        // Access & permissions
        "UserGroups",

    ],

    // ====================================================================================
    // SYSTEM ADMINISTRATION & CONFIGURATION
    // ====================================================================================
    "system": [
        // User management
        "Users",
        "UserDefaultGroups",
        "UserLanguages",
        "UserPermissionTree",
        "UserGroups",

        // System settings
        "AlertManagements",
        "Holidays",
        "Messages",
        "PredefinedTexts",
        "EventNotifications",
        "SingleUserConnections",
        "DynamicSystemStrings",
        "EmailGroups",
        "ShortLinkMappings",
        "Attachments2",
        "DistributionLists",
        "B1Sessions",
        "ElectronicFileFormats",
        "MobileAddOnSetting",
        "TSRExceptionalEvents",

        // Approvals & workflows
        "ApprovalTemplates",
        "ApprovalRequests",
        "ApprovalStages",

        // Integration & automation
        "EventSubscriptions",
        "IntegrationPackagesConfigure",
        "SQLQueries",
        "ValueMapping",
        "ValueMappingCommunication",

        // Data ownership & security
        "DataPrivacyProtection",
        "DataSensitiveStatus",
    ],

    // ====================================================================================
    // CRM & MARKETING
    // ====================================================================================
    "crm": [
        // Blanket agreements
        "BlanketAgreements",

        // Opportunities & sales
        "SalesOpportunities",
        "SalesOpportunitySourcesSetup",
        "SalesOpportunityInterestsSetup",
        "SalesOpportunityReasonsSetup",
        "SalesOpportunityCompetitorsSetup",

        // Activities & engagement
        "Activities",
        "ActivityLocations",
        "ActivityStatuses",
        "ActivityRecipientLists",
        "ActivitySubjects",
        "ActivityTypes",

        // Campaigns & marketing
        "Campaigns",
        "CampaignResponseType",

        // Contacts & relationships
        "Contacts",
        "Relationships",

        // Knowledge & support
        "Queue",

        // Sales forecasting
        "SalesForecast",
        "SalesPersons",
        "Territories",
        "Industries",
        "TargetGroups",
    ],

    // ====================================================================================
    // LOCALIZATION & REGULATORY
    // ====================================================================================
    "localization": [
        // Tax reporting
        "TaxInvoiceReport",
        "SalesTaxInvoices",
        "PurchaseTaxInvoices",
        "Forms1099",
        "TaxExemptReasons",

        // Electronic documents (region-specific)
        "ElectronicDocuments",
        "EBooks",

        // Regional/country-specific documents
        "SelfInvoices",
        "SelfCreditMemos",
        "BEMReplicationPeriods",
        "IntrastatConfiguration",
        "LegalData",
        "FiscalPrinter",
        "TaxReplStateSubs",
        "ExceptionalEvents",

        // Indian specific (GST/TDS)
        "ISDDocuments",
        "ISDInvoices",
        "ISDCreditMemos",
        "ISDRecipientInvoices",
        "ISDRecipientCreditMemos",
        "TaxCodeDeterminationsTCD",
        "Sections",
        "IndiaHsn",
        "IndiaSacCode",
        "NatureOfAssessees",
        // Withholding tax
        "WithholdingTaxCodes",
        "SpecificWTHAmountsService",
        "WTaxTypeCodes",
        "DeductionTaxGroups",
        "DeductionTaxSubGroups",
        "DeductionTaxHierarchies",
        "DeductibleTaxes",
        "NCMCodesSetup",
        "WitholdingTaxDefinition",

        // Brazil-specific
        "BPFiscalRegistryID",
        "BrazilBeverageIndexers",
        "BrazilFuelIndexers",
        "BrazilNumericIndexers",
        "BrazilStringIndexers",
        "BrazilMultiIndexers",
        "GovPayCodes",
        "POSDailySummary",
        "NotaFiscalCFOP",
        "NotaFiscalCST",
        "NotaFiscalUsage",
        "NFModels",
        "NFTaxCategories",

        // Data protection & sensitivity
        "RetornoCodes",
        "TaxWebSites",
        "SalesTaxAuthoritiesTypes",
        "ExportDeterminations",
        "DNFCodeSetup",
        "CIGCodes",
        "CESTCodes",
        "CUPCodes",
        "ImportDeterminations",
    ],

    // ====================================================================================
    // REPORTING & ANALYTICS
    // ====================================================================================
    "reporting": [
        // Reports & types
        "ReportTypes",
        "TaxInvoiceReport",

        // Formatting & layouts
        "DefaultElementsforCR",

        // DATEV or ELSTER export (German accounting)
        "DatevRuns",
        "ElsterRun",

        // User queries
        "UserQueries",
        "QueryCategories",
        "QueryAuthGroups",

        // Preferences
        "KPIs",
        "SQLQueries",
        "SQLViews",
        "ReportFilter",
    ],

    // ====================================================================================
    // WEB CLIENT & USER INTERFACE CONFIGURATION
    // ====================================================================================
    "ui": [
        "WebClientListviewFilters",
        "WebClientPreferences",
        "WebClientVariants",
        "WebClientVariantGroups",
        "WebClientFormSettings",
        "WebClientDashboards",
        "WebClientRecentActivities",
        "WebClientBookmarkTiles",
        "WebClientNotifications",
        "WebClientLaunchpads",
        "ColumnPreferences",
        "FormPreferences",
        "ExtendedTranslations",
        "PredefinedTexts",
        "MultiLanguageTranslations",
        "ChooseFromList",
        "Cockpits",
    ],

};

/** The user-defined categories, which the map cannot list: a tenant's own tables and objects. */
export const USER_DEFINED = { udt: "user-defined-table", udo: "user-defined-object" } as const;

export const CATEGORY_NAMES: string[] = [...Object.keys(B1_CATEGORIES), ...Object.values(USER_DEFINED)];

const byEntity = new Map<string, string[]>();
for (const [category, names] of Object.entries(B1_CATEGORIES))
  for (const n of names) {
    const k = n.toLowerCase();
    const list = byEntity.get(k) ?? [];
    if (!list.includes(category)) byEntity.set(k, [...list, category]);
  }

/** An entity set's categories: the map's, or its user-defined one. */
export const categoriesOf = (e: Pick<B1EntityRef, "name" | "entityClass">): string[] =>
  e.entityClass === "standard" ? byEntity.get(e.name.toLowerCase()) ?? [] : [USER_DEFINED[e.entityClass]];
