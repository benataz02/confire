package main

import (
	"net/url"
	"testing"
)

// The allowlist is the agent's security boundary: methods × paths × headers.
func TestAllow(t *testing.T) {
	b1, _ := url.Parse("https://sap:50000/b1s/v2/")
	beas, _ := url.Parse("https://sap:8443/beas/api/")
	cases := []struct {
		base    *url.URL
		method  string
		path    string
		headers map[string]string
		want    string // the URL sent, "" = refused
	}{
		// Reads: anything under the base, as query.ts writes it.
		{b1, "GET", "Items?$top=5&$filter=ItemCode%20eq%20'A'", nil, "https://sap:50000/b1s/v2/Items?$top=5&$filter=ItemCode%20eq%20'A'"},
		{b1, "GET", "Items('0000377')", nil, "https://sap:50000/b1s/v2/Items('0000377')"},
		{b1, "GET", "Items('A B')", nil, "https://sap:50000/b1s/v2/Items('A%20B')"},
		{b1, "GET", "Items('50%')", nil, "https://sap:50000/b1s/v2/Items('50%25')"},
		{b1, "GET", "$metadata?scope=entityset&annotation=labelWithTable", nil, "https://sap:50000/b1s/v2/$metadata?scope=entityset&annotation=labelWithTable"},
		{b1, "GET", "$crossjoin(Orders,Orders/DocumentLines)?$expand=Orders($select=DocEntry),Orders/DocumentLines($select=BaseEntry)&$filter=x", nil,
			"https://sap:50000/b1s/v2/$crossjoin(Orders,Orders/DocumentLines)?$expand=Orders($select=DocEntry),Orders/DocumentLines($select=BaseEntry)&$filter=x"},
		{b1, "GET", "CompanyService_GetAdminInfo", nil, "https://sap:50000/b1s/v2/CompanyService_GetAdminInfo"},
		// B1's nextLinks, relative or absolute.
		{b1, "GET", "Items?$skip=20", map[string]string{"Prefer": "odata.maxpagesize=20"}, "https://sap:50000/b1s/v2/Items?$skip=20"},
		{b1, "GET", "/b1s/v2/Items?$skip=20", nil, "https://sap:50000/b1s/v2/Items?$skip=20"},
		{b1, "GET", "https://sap:50000/b1s/v2/Items?$skip=20", nil, "https://sap:50000/b1s/v2/Items?$skip=20"},
		// Outside the base.
		{b1, "GET", "https://evil.example/b1s/v2/Items", nil, ""},
		{b1, "GET", "//evil.example/b1s/v2/Items", nil, ""},
		{b1, "GET", "http://sap:50000/b1s/v2/Items", nil, ""},
		{b1, "GET", "https://user@sap:50000/b1s/v2/Items", nil, ""},
		{b1, "GET", "../../etc/passwd", nil, ""},
		{b1, "GET", "/b1s/v1/Items", nil, ""},
		{b1, "GET", "%2e%2e/v1/Items", nil, ""},
		{b1, "GET", "Items/%2E%2E/%2e%2e/x", nil, ""},
		{beas, "GET", "../../b1s/v2/Items", nil, ""},
		{beas, "GET", "WorkOrders?$top=1", nil, "https://sap:8443/beas/api/WorkOrders?$top=1"},
		// The agent owns the session.
		{b1, "POST", "Login", nil, ""},
		{b1, "POST", "Logout", nil, ""},
		{b1, "GET", "logout", nil, ""},
		{b1, "POST", "/b1s/v2/Login", nil, ""},
		// Writes.
		{b1, "POST", "Quotations", map[string]string{"Prefer": "return-representation"}, "https://sap:50000/b1s/v2/Quotations"},
		{b1, "POST", "SeriesService_GetDocumentSeries", nil, "https://sap:50000/b1s/v2/SeriesService_GetDocumentSeries"},
		{b1, "POST", "Quotations(5)/Close", nil, "https://sap:50000/b1s/v2/Quotations(5)/Close"},
		{b1, "POST", "Quotations(5)/Cancel", nil, ""},
		{b1, "POST", "Orders(5)/Close", nil, ""},
		{b1, "POST", "Quotations(5)", nil, ""},
		{b1, "POST", "Orders/DocumentLines", nil, ""},
		{b1, "POST", "Quotations?$select=DocEntry", nil, ""},
		{b1, "PATCH", "Quotations(5)", map[string]string{"If-Match": `W/"1"`, "B1S-ReplaceCollectionsOnPatch": "true"}, "https://sap:50000/b1s/v2/Quotations(5)"},
		{b1, "PATCH", "BusinessPartners('C''1')", nil, "https://sap:50000/b1s/v2/BusinessPartners('C''1')"},
		{b1, "PATCH", "ProductTrees(TreeCode='A',Rev=2)", nil, "https://sap:50000/b1s/v2/ProductTrees(TreeCode='A',Rev=2)"},
		{b1, "PATCH", "Items('a)/Close')", nil, "https://sap:50000/b1s/v2/Items('a)/Close')"}, // a key, however odd
		{b1, "PATCH", "Quotations", nil, ""},
		{b1, "PATCH", "Quotations(5)/Close", nil, ""},
		{b1, "PATCH", "Items('x')/Nav('y')", nil, ""},
		{b1, "PATCH", "Quotations(5)?x=1", nil, ""},
		{b1, "PATCH", "Quotations(abc)", nil, ""},
		{b1, "DELETE", "Quotations(5)", nil, "https://sap:50000/b1s/v2/Quotations(5)"},
		{b1, "DELETE", "Quotations", nil, ""},
		{b1, "PUT", "Quotations(5)", nil, ""},
		{b1, "OPTIONS", "Items", nil, ""},
		// Headers: three pass, nothing else.
		{b1, "GET", "Items", map[string]string{"prefer": "odata.maxpagesize=5"}, "https://sap:50000/b1s/v2/Items"},
		{b1, "GET", "Items", map[string]string{"Cookie": "B1SESSION=x"}, ""},
		{b1, "GET", "Items", map[string]string{"Authorization": "Basic x"}, ""},
		{b1, "GET", "Items", map[string]string{"B1S-CaseInsensitive": "true"}, ""},
	}
	for _, c := range cases {
		got, err := allow(c.base, c.method, c.path, c.headers)
		switch {
		case c.want == "" && err == nil:
			t.Errorf("%s %s: allowed as %s, want refused", c.method, c.path, got.URL)
		case c.want != "" && err != nil:
			t.Errorf("%s %s: refused (%v), want %s", c.method, c.path, err, c.want)
		case c.want != "" && got.URL.String() != c.want:
			t.Errorf("%s %s: sent as %s, want %s", c.method, c.path, got.URL, c.want)
		}
	}
	a, _ := allow(b1, "GET", "Items", map[string]string{"prefer": "odata.maxpagesize=5"})
	if a.Headers["Prefer"] != "odata.maxpagesize=5" || len(a.Headers) != 1 {
		t.Errorf("headers passed as %v", a.Headers)
	}
}
