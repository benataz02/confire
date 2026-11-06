// confire-print.exe — Direct printing (print spec §5.3): renders a B1 Crystal layout to PDF with the
// box's Crystal Reports runtime for .NET, outside B1 and without the API Gateway. The agent runs it
// as a child (apps/agent/crystal.go): one JSON line in, one out, on stdin/stdout; logs go to stderr.
//
//   in:  {"layout":"QUT20009","docEntry":5,"objectId":23}
//   out: {"pdf":"<base64>"} or {"error":"<message>"}
//
// `confire-print.exe --check` is the agent wizard's test. The SQL login comes from the environment
// (CONFIRE_SQL_SERVER/USER/PASS), never the command line; the database is always CONFIRE_COMPANY_DB,
// the company the agent serves, so another company's documents cannot be printed.
//
// Crystal is bound at runtime (LoadWithPartialName from the GAC, driven as `dynamic`), the approach
// the spike verified, so no SAP DLL is referenced at build time.

using System;
using System.Collections.Generic;
using System.Data.SqlClient;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;

static class Program
{
    static readonly string Server = Environment.GetEnvironmentVariable("CONFIRE_SQL_SERVER");
    static readonly string User = Environment.GetEnvironmentVariable("CONFIRE_SQL_USER");
    static readonly string Pass = Environment.GetEnvironmentVariable("CONFIRE_SQL_PASS");
    static readonly string Company = Environment.GetEnvironmentVariable("CONFIRE_COMPANY_DB");
    static readonly TimeSpan LayoutTtl = TimeSpan.FromHours(2);

    static Assembly engine, shared;

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--check") return Check();
        var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        // Anything else that writes to the console (Crystal, a library) must not break the protocol.
        Console.SetOut(Console.Error);
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            object reply;
            try
            {
                var req = json.Deserialize<Request>(line);
                reply = new { pdf = Render(req.layout, req.docEntry, req.objectId) };
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e);
                reply = new { error = Message(e) };
            }
            stdout.WriteLine(json.Serialize(reply));
        }
        return 0;
    }

    class Request
    {
        public string layout { get; set; }
        public long docEntry { get; set; }
        public int objectId { get; set; }
    }

    static int Check()
    {
        try
        {
            using (var sql = Sql())
            using (var cmd = new SqlCommand("SELECT COUNT(*) FROM RDOC", sql))
                cmd.ExecuteScalar();
            LoadCrystal();
            Console.WriteLine("ok Crystal " + FileVersionInfo.GetVersionInfo(engine.Location).FileVersion);
            return 0;
        }
        catch (Exception e)
        {
            Console.WriteLine(Message(e));
            return 1;
        }
    }

    static SqlConnection Sql()
    {
        if (string.IsNullOrEmpty(Server) || string.IsNullOrEmpty(User) || string.IsNullOrEmpty(Company))
            throw new InvalidOperationException("CONFIRE_SQL_SERVER, CONFIRE_SQL_USER and CONFIRE_COMPANY_DB must be set");
        var cs = new SqlConnectionStringBuilder { DataSource = Server, InitialCatalog = Company, UserID = User, Password = Pass ?? "" };
        var sql = new SqlConnection(cs.ConnectionString);
        sql.Open();
        return sql;
    }

    static void LoadCrystal()
    {
        if (engine != null) return;
#pragma warning disable 618 // LoadWithPartialName: the box's version, whatever SP it is on
        engine = Assembly.LoadWithPartialName("CrystalDecisions.CrystalReports.Engine");
        shared = Assembly.LoadWithPartialName("CrystalDecisions.Shared");
#pragma warning restore 618
        if (engine == null || shared == null)
            throw new InvalidOperationException("No Crystal Reports runtime for .NET (64-bit) on this server. Install SAP Crystal Reports runtime for .NET, 64-bit.");
    }

    class Loaded
    {
        public dynamic Doc;
        public DateTime Until;
    }

    // ponytail: layouts held loaded per code, 2 h — Crystal's job limit (75) is far off at 4 document types
    static readonly Dictionary<string, Loaded> layouts = new Dictionary<string, Loaded>();

    static dynamic Layout(string code)
    {
        Loaded l;
        if (layouts.TryGetValue(code, out l))
        {
            if (l.Until > DateTime.UtcNow) return l.Doc;
            layouts.Remove(code);
            l.Doc.Close();
            l.Doc.Dispose();
        }
        byte[] bytes;
        using (var sql = Sql())
        using (var cmd = new SqlCommand("SELECT Template FROM RDOC WHERE DocCode = @c", sql))
        {
            cmd.Parameters.AddWithValue("@c", code);
            bytes = cmd.ExecuteScalar() as byte[];
        }
        if (bytes == null) throw new InvalidOperationException(string.Format("Layout {0} is not in RDOC", code));
        if (bytes.Length < 4 || bytes[0] != 0xD0 || bytes[1] != 0xCF || bytes[2] != 0x11 || bytes[3] != 0xE0)
            throw new InvalidOperationException(string.Format("Layout {0} in RDOC is not a Crystal .rpt", code));
        var dir = Path.Combine(Path.GetTempPath(), "confire-print");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, code + ".rpt");
        File.WriteAllBytes(path, bytes);

        LoadCrystal();
        dynamic doc = Activator.CreateInstance(engine.GetType("CrystalDecisions.CrystalReports.Engine.ReportDocument", true));
        doc.Load(path);
        // B1's layouts carry the connection they were designed on: point every table, the
        // subreports' too, at this server and the agent's company.
        Connect(doc);
        foreach (dynamic sub in doc.Subreports) Connect(sub);
        layouts[code] = new Loaded { Doc = doc, Until = DateTime.UtcNow + LayoutTtl };
        return doc;
    }

    static void Connect(dynamic report)
    {
        foreach (dynamic table in report.Database.Tables)
        {
            dynamic logon = table.LogOnInfo;
            dynamic ci = logon.ConnectionInfo;
            ci.ServerName = Server;
            ci.DatabaseName = Company;
            ci.UserID = User;
            ci.Password = Pass ?? "";
            table.ApplyLogOnInfo(logon);
        }
    }

    static string Render(string code, long docEntry, int objectId)
    {
        if (string.IsNullOrEmpty(code) || docEntry < 1) throw new ArgumentException("A print needs a layout and a document key");
        dynamic doc = Layout(code);
        // Main report parameters only: a subreport's are linked to the main report's by Crystal.
        foreach (dynamic p in doc.DataDefinition.ParameterFields)
        {
            if ((string)p.ReportName != "") continue;
            var name = (string)p.Name;
            if (name != "DocKey@" && name != "ObjectId@") continue;
            long value = name == "DocKey@" ? docEntry : objectId;
            object typed = p.ParameterValueKind.ToString() == "StringParameter" ? (object)value.ToString() : (double)value;
            doc.SetParameterValue(name, typed);
        }
        var pdf = Enum.Parse(shared.GetType("CrystalDecisions.Shared.ExportFormatType", true), "PortableDocFormat");
        using (Stream s = doc.ExportToStream((dynamic)pdf))
        using (var ms = new MemoryStream())
        {
            s.CopyTo(ms);
            return Convert.ToBase64String(ms.ToArray());
        }
    }

    static string Message(Exception e)
    {
        var parts = new List<string>();
        for (; e != null; e = e.InnerException)
            if (!(e is TargetInvocationException) && !parts.Contains(e.Message)) parts.Add(e.Message);
        return string.Join(": ", parts);
    }
}
