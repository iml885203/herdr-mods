import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfigPath, redactDiff, redactText } from "../mods/session-changes/redact.js";

const section = (path, ...lines) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map((l) => `${l}\n`).join("")}`;
const body = (path, ...lines) => redactDiff(section(path, ...lines)).split("\n").slice(4, 4 + lines.length);
const one = (path, line) => body(path, line)[0];

test("a credential-keyed value is redacted and its key kept, in config files", () => {
  const cases = [
    ["app.yaml", "+JWT_SECRET: abcdef", "JWT_SECRET", "abcdef"],
    ["app.yaml", "+  MYSQL_PASS: x", "MYSQL_PASS", ": x"],
    ["settings.ini", "+DB_PASSWORD=hunter2", "DB_PASSWORD", "hunter2"],
    ["db.env", "+password=hunter2", "password", "hunter2"],
    ["secrets.env", "+api_key=abc123def", "api_key", "abc123def"],
    ["app.cfg", "+passwd=hunter2", "passwd", "hunter2"],
    ["run.sh", "+export STRIPE_API_KEY=sk_live_abc", "STRIPE_API_KEY", "sk_live_abc"],
    ["run.sh", "+GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123", "GITHUB_TOKEN", "ghp_"],
    ["appsettings.json", '+  "ClientSecret": "abc123",', "ClientSecret", "abc123"],
    ["appsettings.json", '+  "SecretKey": "abc",', "SecretKey", '"abc"'],
    ["appsettings.Production.json", '+  "ConnectionString": "Server=db;Trusted=true"', "ConnectionString", "Server=db"],
    ["app.conf", "+private_key: MIIEvQIBADANBg", "private_key", "MIIEvQ"],
    ["app.properties", "+DATABASE_PASSWD='x1y2'", "DATABASE_PASSWD", "x1y2"],
    ["app.config", "+AccountKey=abc123def456==", "AccountKey", "abc123def456"],
    ["app.config", "+SharedAccessKey=xyz789abc", "SharedAccessKey", "xyz789abc"],
    ["app.config", "+DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abcdef==;EndpointSuffix=core.windows.net", "AccountName=a", "abcdef=="],
    ["x.toml", "+connection_string = 'host=x dbname=y'", "connection_string", "dbname"],
    ["x.toml", "+ClientSecret: s3cr3t-value", "ClientSecret", "s3cr3t"],
    ["Dockerfile", "+ENV DB_PASS=hunter2xyz", "DB_PASS", "hunter2xyz"],
    ["x.yml", '+  "credential": "abc123xyz"', "credential", "abc123xyz"],
    ["x.yml", "+pass: 'x1'", "pass", "x1"],
    ["x.tfvars", "+SMTP_PW=abc", "SMTP_PW", "=abc"],
    ["x.tf", '+passphrase="x"', "passphrase", '"x"'],
    [".env.example", "+SECRET_KEY=abcdef", "SECRET_KEY", "abcdef"],
    [".env.example", "+AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "AWS_SECRET_ACCESS_KEY", "wJalr"],
    ["x.yaml", "+SigningKey: abc123", "SigningKey", "abc123"],
    ["x.yaml", "+ACCESS_KEY: AKIAABCDEFGHIJKLMNOP", "ACCESS_KEY", "AKIA"],
    ["x.ini", "+password=abc.def", "password", "abc.def"],
    ["x.ini", "+Password=hunter2", "Password", "hunter2"],
    ["x.ini", "+pwd=abc", "pwd", "=abc"],
  ];
  for (const [path, line, key, secret] of cases) {
    const out = one(path, line);
    assert.ok(out.includes(key), `${path}: key lost in ${out}`);
    assert.ok(!out.includes(secret), `${path}: ${secret} survived in ${out}`);
    assert.ok(out.includes("‹"), out);
  }
});

test("a credential-keyed value is redacted in source files too, quotes and the rest of the line kept", () => {
  const cases = [
    ["a.cs", '+const string Password = "hunter2";', 'const string Password = "‹v›";'],
    ["a.ps1", "+$pw = 'hunter2'", "$pw = '‹v›'"],
    ["a.go", '+password := "secret"', 'password := "‹v›"'],
    ["a.js", "+let password = hunter2hunter2", "let password = ‹v›"],
    ["a.cs", '+var cs = "Server=db;Password=hunter2;User Id=sa;";', 'var cs = "Server=db;Password=‹v›;User Id=sa;";'],
    ["a.cs", '+var password = isProd ? "hunter2" : "devpass1";', 'var password = isProd ? "‹v›" : "‹v›";'],
    ["a.http", "+Authorization: Bearer abcdef123456", "Authorization: Bearer ‹v›"],
    ["a.sh", "+mysql -uroot -pSecretPass123 shop", "mysql -uroot -p‹v› shop"],
    ["a.sh", "+mysqldump --password hunter2 shop > out.sql", "mysqldump --password ‹v› shop > out.sql"],
    ["a.sh", "+curl -u admin --token abc123def api.example.com", "curl -u admin --token ‹v› api.example.com"],
    ["a.sh", '+if [ "$MODE" = "prod" ]; then PASSWORD=hunter2 run; fi', 'if [ "$MODE" = "prod" ]; then PASSWORD=‹v› run; fi'],
  ];
  for (const [path, line, expected] of cases) assert.equal(one(path, line), `+${expected}`, line);
});

test("xml elements and attribute pairs keyed by a credential are redacted", () => {
  assert.equal(one("a.config", "+  <Password>hunter2</Password>"), "+  <Password>‹v›</Password>");
  assert.equal(one("a.config", '+  <add key="DbPassword" value="hunter2"/>'), '+  <add key="DbPassword" value="‹v›"/>');
  assert.equal(one("a.config", '+  <add key="Theme" value="dark"/>'), '+  <add key="Theme" value="dark"/>');
  assert.equal(one("a.config", "+  <Timeout>30</Timeout>"), "+  <Timeout>30</Timeout>");
});

test("a k8s env entry keeps its structure and loses the value on the line after a credential name", () => {
  const out = body("deploy.yaml", "+        - name: DB_PASSWORD", "+          value: hunter2", "+        - name: DB_HOST", "+          value: db.internal");
  assert.deepEqual(out, ["+        - name: DB_PASSWORD", "+          value: ‹v›", "+        - name: DB_HOST", "+          value: db.internal"]);
});

test("a value on the line after a credential name in a different hunk is not guessed at", () => {
  const diff = section("deploy.yaml", "+        - name: DB_PASSWORD") + "@@ -9,1 +9,1 @@\n+          value: keep-me\n";
  assert.ok(redactDiff(diff).includes("value: keep-me"));
});

test("multi-line strings are covered because every line is judged on its own", () => {
  assert.deepEqual(body("a.cs", '+var sql = @"', "+  Server=db;Password=hunter2;User Id=sa;", '+";'), ['+var sql = @"', "+  Server=db;Password=‹v›;User Id=sa;", '+";']);
  assert.deepEqual(body("a.ts", "+const cfg = `", "+  password: hunter2hunter2", "+`;"), ["+const cfg = `", "+  password: ‹v›", "+`;"]);
  assert.deepEqual(body("a.py", '+CFG = """', "+api_key = abc12345", '+"""'), ['+CFG = """', "+api_key = ‹v›", '+"""']);
});

test("contracts survive: routes, stored procedure names, field names, i18n keys, images, versions, shell tests", () => {
  const lines = [
    ["a.cs", '+    [HttpGet("api/orders/{id}")]'], ["a.cs", '+    cmd.CommandText = "usp_GetMemberBalance";'], ["a.cs", '+    [JsonPropertyName("player_id")]'],
    ["a.ts", '+    title: t("wallet.balance.title"),'], ["compose.yaml", "+    image: ghcr.io/x/api:1.4.2"], ["package.json", '+    "axios": "^1.7.0",'],
    ["run.sh", '+if [ "$ENV" = "prod" ]; then echo deploying to production; fi'], ["a.cs", '+    var url = "https://example.com/api/v1/orders";'],
    ["a.cs", '+    private const string MemberBalanceQueryName = "usp_GetMemberBalanceByCurrency";'], ["messages.json", '+  "wallet.title": "Your wallet",'],
  ];
  for (const [path, line] of lines) assert.equal(one(path, line), line, line);
});

test("a changed config file is still readable after redaction", () => {
  const out = body("appsettings.json", '+  "Redis": {', '+    "Host": "redis.internal.example",', '+    "Password": "hunter2",', '+    "TimeoutSeconds": 30', "+  }");
  assert.deepEqual(out, ['+  "Redis": {', '+    "Host": "redis.internal.example",', '+    "Password": "‹v›",', '+    "TimeoutSeconds": 30', "+  }"]);
});

test("placeholders and expressions are not values, so code and templates stay as they are", () => {
  const same = [
    ["a.cs", "+public async Task Run(CancellationToken cancellationToken = new())"], ["a.cs", "+    Token = request.PlayerId,"], ["a.ts", "+this.token = (this.token ?? 0) + 1;"],
    ["a.ts", "+const token = ++this.filterToken;"], ["a.ts", "+if (token == null) return;"], ["a.cs", "+var bypass = true;"], ["a.ts", "+  password: string;"],
    ["a.cs", "+public string Password { get; set; }"], ["a.cs", "+const passwordHash = hash(input);"], ["a.ts", "+    credentials: include,"], ["a.md", "+  <your-password>"],
    ["a.sh", "+docker run -e PASSWORD=$PASSWORD img"], ["a.yaml", '+  password: "${DB_PASSWORD}"'], ["a.yaml", "+  password: {{ .Values.password }}"],
    ["a.sh", '+export PASSWORD="$(cat /run/secrets/pw)"'], ["a.ts", '+    secretPath: "secret/data/members/redis",'], ["a.cs", "+var compass = heading;"],
    ["a.cs", "+var rate = 3;"], ["a.cs", '+    var password = ReadPassword();'], ["a.cs", "+    password = passwordInput;"],
  ];
  for (const [path, line] of same) assert.equal(one(path, line), line, line);
});

test("userinfo in a URL, an empty user included, and scheme-less user:pass@host become a marker", () => {
  assert.equal(one("a.cs", "+x = postgres://admin:s3cret@db.internal/app"), "+x = postgres://‹u›@db.internal/app");
  assert.equal(one("a.cs", "+x = redis://:pw@host:6379"), "+x = redis://‹u›@host:6379");
  assert.equal(one("a.cs", "+x = mongodb+srv://u:p4ssw0rd@cluster.example"), "+x = mongodb+srv://‹u›@cluster.example");
  assert.equal(one("a.cs", "+sa:J7cEx9aBkLm@db.internal"), "+‹u›@db.internal");
  assert.equal(one("a.cs", "+x = ssh://git@github.com/org/repo"), "+x = ssh://git@github.com/org/repo");
});

test("tokens with a known shape become a marker wherever they are", () => {
  const tokens = [
    "AKIAABCDEFGHIJKLMNOP", "ghp_abcdefghijklmnopqrstuvwxyz0123", "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz", "glpat-AbCdEfGhIjKlMnOpQrSt",
    "sk_live_AbCdEfGhIj123456", "rk_live_AbCdEfGhIj123456", "pk_live_AbCdEfGhIj123456", "AIzaSyA-1234567890abcdefghijklmnopqrstu",
    "npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "glsa_AbCdEfGhIjKlMnOpQrStUv_01234567", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz-0123",
    "xoxb-123456789012-abcdefghij", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig",
  ];
  for (const token of tokens) assert.equal(one("a.md", `+see ${token} for it`), "+see ‹t› for it", token);
  assert.equal(one("a.md", "+Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"), "+Authorization: Bearer ‹v›");
});

test("a private key block is replaced line by line, begin and end included", () => {
  const out = body("a.md", "+-----BEGIN RSA PRIVATE KEY-----", "+MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "+abcdEFGH1234+/ijklMNOP5678qrstUVWX9012yz==", "+-----END RSA PRIVATE KEY-----", "+after the key");
  assert.deepEqual(out, ["+‹t›", "+‹t›", "+‹t›", "+‹t›", "+after the key"]);
});

test("a random-looking run of 32 or more characters is replaced, a long identifier, a path or a hash is not", () => {
  assert.equal(one("a.cs", "+x = Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O;"), "+x = ‹t›;");
  assert.equal(one("a.cs", "+const x = aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF;"), "+const x = ‹t›;");
  for (const line of [
    "+  MemberAuth__Redis__Hosts__0__Host: redis.internal", "+public class V01_06_DropCreatedOnIndexOnVipSetting : Migration",
    "+public void Live22_uses_dual_currency_sqids_on_every_brand()", "+Subproject commit 1111111111111111111111111111111111111111",
    "+id = example_token_0000000000000000", "+using Acme.Shop.Gateway/Services/Bets/BetSettlementService2.cs",
    "+    migrationBuilder.CreateIndex(\"IX_Otp_Phone\", \"Otp\", \"PhoneNumber\");",
  ]) assert.equal(one("a.cs", line), line, line);
});

test("diff headers, hunk headers, context lines, removed lines and the no-newline note are handled by their marker", () => {
  const out = redactDiff(section("x.ini", " keep=1", "-old_password=hunter2", "+new_password=hunter3", "\\ No newline at end of file"));
  assert.ok(out.startsWith("diff --git a/x.ini b/x.ini\n--- a/x.ini\n+++ b/x.ini\n@@ -1,4 +1,4 @@\n"));
  assert.ok(out.includes(" keep=1") && out.includes("-old_password=‹v›") && out.includes("+new_password=‹v›"));
  assert.ok(out.includes("\\ No newline at end of file") && !out.includes("hunter"));
});

test("redaction is idempotent and never withholds a hunk", () => {
  const diff = section("app.yaml", "+JWT_SECRET: abcdef", '+url: "postgres://a:b@h/db"') + section("a.cs", '+var password = "supersecretvalue";', "+keep this line");
  const once = redactDiff(diff);
  assert.equal(redactDiff(once), once);
  assert.ok(!once.includes("withheld") && once.includes("+keep this line"));
});

test("redactText redacts the parts of a prompt around the diff, and leaves paths alone", () => {
  assert.equal(redactText("fix: rotate DB_PASSWORD=hunter2"), "fix: rotate DB_PASSWORD=‹v›");
  assert.equal(redactText("- use redis://:pw@host and ghp_abcdefghijklmnopqrstuvwxyz0123"), "- use redis://‹u›@host and ‹t›");
  assert.equal(redactText("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj\n-----END PRIVATE KEY-----\nafter"), "‹t›\nafter");
  for (const path of ["M Migrations/20261104123456_AddOtpIndexes.cs +3 -0", "A src/AaBbCc1122334455DdEeFf6677889900ggHh/Service.cs +10 -0", "M Controllers/PasswordController.cs +4 -1"]) assert.equal(redactText(path), path);
});

test("isConfigPath knows the config-shaped files and not source files", () => {
  for (const path of ["a.json", "x/b.yaml", "c.yml", ".env.local", "d.ini", "e.properties", "f.toml", "g.conf", "App.config", "Dockerfile", "docker-compose.yml", "run.sh", "main.tf", "x.tfvars", "src/appsettings.Production.json", "a.cfg", "db.env"]) assert.ok(isConfigPath(path), path);
  for (const path of ["a.cs", "b.ts", "c.vue", "README.md", "d.sql", "Program.cs"]) assert.ok(!isConfigPath(path), path);
});

test("unquoted ${VAR} and $(cmd) placeholders keep their variable, and only a default after :- is redacted", () => {
  const cases = [
    ["compose.yml", "+  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}", "+  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}"],
    ["compose.yml", "+  DB_PASSWORD=${DB_PASSWORD:-changeme}", "+  DB_PASSWORD=${DB_PASSWORD:-‹v›}"],
    ["compose.yml", "+  DB_PASSWORD: ${DB_PASSWORD:?missing}", "+  DB_PASSWORD: ${DB_PASSWORD:?missing}"],
    ["a.cs", '+var cs = "Server=db;Password=${P};User Id=sa";', '+var cs = "Server=db;Password=${P};User Id=sa";'],
    ["a.sh", "+PASSWORD=$(cat /run/secrets/pw) run", "+PASSWORD=$(cat /run/secrets/pw) run"],
    ["a.sh", '+PASSWORD="${DB_PASSWORD:-changeme}"', '+PASSWORD="${DB_PASSWORD:-‹v›}"'],
    ["a.sh", "+export TOKEN=$TOKEN", "+export TOKEN=$TOKEN"],
  ];
  for (const [path, line, expected] of cases) assert.equal(one(path, line), expected, line);
});

test("a value inside another value is redacted once, and the closing quote and tag survive", () => {
  assert.equal(one("a.go", '+dsn := "host=db user=u password=abc12345 dbname=x"'), '+dsn := "‹v›"');
  assert.equal(one("web.config", '+  <add name="Db" connectionString="Server=.;Password=abc123;" />'), '+  <add name="Db" connectionString="‹v›" />');
});

test("typed declarations are followed to the value after the equals sign", () => {
  assert.equal(one("a.ts", '+const password: string = "abc12345";'), '+const password: string = "‹v›";');
  assert.equal(one("a.ts", '+  private readonly apiKey: string = "abc123def";'), '+  private readonly apiKey: string = "‹v›";');
  assert.equal(one("a.py", '+password: str = "abc12345"'), '+password: str = "‹v›"');
  assert.equal(one("a.ts", "+  password: string;"), "+  password: string;");
  assert.equal(one("a.ts", "+const token: string = getToken();"), "+const token: string = getToken();");
});

test("quoted keys are credentials too: subscripts, two-argument calls and auth tuples", () => {
  const cases = [
    ['+os.environ["API_KEY"] = "abc123def"', '+os.environ["API_KEY"] = "‹v›"'],
    ['+headers["X-Api-Key"] = "abc123"', '+headers["X-Api-Key"] = "‹v›"'],
    ['+client.DefaultRequestHeaders.Add("X-Api-Key", "abc123");', '+client.DefaultRequestHeaders.Add("X-Api-Key", "‹v›");'],
    ['+os.Setenv("TOKEN", "abc123")', '+os.Setenv("TOKEN", "‹v›")'],
    ['+r = requests.get(url, auth=("user", "pass1234"))', '+r = requests.get(url, auth=("user", "‹v›"))'],
    ['+key = os.environ["API_KEY"]', '+key = os.environ["API_KEY"]'],
    ['+x = headers["Content-Type"] = "application/json"', '+x = headers["Content-Type"] = "application/json"'],
    ['+var v = Environment.GetEnvironmentVariable("API_KEY");', '+var v = Environment.GetEnvironmentVariable("API_KEY");'],
  ];
  for (const [line, expected] of cases) assert.equal(one("a.py", line), expected, line);
});

test("command-line passwords for docker login, sqlcmd and curl -u are redacted, keeping the user", () => {
  const cases = [
    ["+docker login -u me -p hunter2 registry.example.com", "+docker login -u me -p ‹v› registry.example.com"],
    ["+docker login registry.example.com --password hunter2 -u me", "+docker login registry.example.com --password ‹v› -u me"],
    ["+sqlcmd -S db -U sa -P Hunter2xyz -Q select1", "+sqlcmd -S db -U sa -P ‹v› -Q select1"],
    ["+curl -u admin:pass1234 https://api.example.com/x", "+curl -u admin:‹v› https://api.example.com/x"],
    ["+curl --user admin:pass1234 https://api.example.com/x", "+curl --user admin:‹v› https://api.example.com/x"],
    ["+curl -u admin https://api.example.com/x", "+curl -u admin https://api.example.com/x"],
    ["+docker run -p 8080:80 img", "+docker run -p 8080:80 img"],
  ];
  for (const [line, expected] of cases) assert.equal(one("a.sh", line), expected, line);
});

test("prose in a commit subject is not an assignment, but an env-style NAME=value is", () => {
  assert.equal(redactText("auth: add refresh token rotation"), "auth: add refresh token rotation");
  assert.equal(redactText("fix: password reset email"), "fix: password reset email");
  assert.equal(redactText("fix: rotate DB_PASSWORD=hunter2"), "fix: rotate DB_PASSWORD=‹v›");
  assert.equal(redactText("chore: set token=abc123 for ci"), "chore: set token=‹v› for ci");
});

test("a path in a diff header is treated like any other plain text", () => {
  const out = redactDiff("diff --git a/x/DB_PASSWORD=hunter3.txt b/x/DB_PASSWORD=hunter3.txt\n--- a/x/DB_PASSWORD=hunter3.txt\n+++ b/x/DB_PASSWORD=hunter3.txt\n@@ -1 +1 @@\n+ok\n");
  assert.ok(!out.includes("hunter3") && out.includes("+ok") && out.includes("@@ -1 +1 @@"));
  const normal = "diff --git a/Migrations/20261104123456_AddOtpIndexes.cs b/Migrations/20261104123456_AddOtpIndexes.cs\n--- a/Migrations/20261104123456_AddOtpIndexes.cs\n+++ b/Migrations/20261104123456_AddOtpIndexes.cs\n@@ -1 +1 @@\n+ok\n";
  assert.equal(redactDiff(normal), normal);
});

test("a C# property with a default value is a credential-keyed assignment", () => {
  assert.equal(one("a.cs", '+    public string Password { get; set; } = "hunter22";'), '+    public string Password { get; set; } = "‹v›";');
  assert.equal(one("a.cs", "+    public string Name { get; set; } = \"Alice Example\";"), "+    public string Name { get; set; } = \"Alice Example\";");
});

test("the function context git prints after a hunk header is redacted like any other line", () => {
  const code = redactDiff("diff --git a/a.cs b/a.cs\n--- a/a.cs\n+++ b/a.cs\n@@ -27,5 +27,5 @@ DB_PASSWORD=Xk9fQ2mPz71vLw0Rt\n+ok\n");
  assert.ok(code.includes("@@ -27,5 +27,5 @@ DB_PASSWORD=‹v›\n") && !code.includes("Xk9f"));
  const cfg = redactDiff("diff --git a/app.yaml b/app.yaml\n--- a/app.yaml\n+++ b/app.yaml\n@@ -1,2 +1,2 @@ password: hunter2\n+ok\n");
  assert.ok(cfg.includes("@@ -1,2 +1,2 @@ password: ‹v›") && !cfg.includes("hunter2"));
  const plain = "diff --git a/a.cs b/a.cs\n--- a/a.cs\n+++ b/a.cs\n@@ -1,2 +1,2 @@ public async Task Run(CancellationToken ct)\n+ok\n";
  assert.equal(redactDiff(plain), plain);
});

test("a very long line is replaced before any pattern runs, so redaction stays fast", () => {
  const started = performance.now();
  const out = redactDiff(section("a.cs", "+" + "word ".repeat(16000), "+short line stays", "+" + "a=b;".repeat(20000)));
  assert.ok(performance.now() - started < 300, `${performance.now() - started} ms`);
  assert.deepEqual(out.split("\n").slice(4, 7), ["+‹long line›", "+short line stays", "+‹long line›"]);
});

test("the patterns themselves do not blow up on a long run of word characters", () => {
  const started = performance.now();
  for (const line of ["a".repeat(900), "a.b-".repeat(225), "x=".repeat(450), "key ".repeat(225) + "=;"]) redactDiff(section("a.cs", `+${line}`));
  assert.ok(performance.now() - started < 200, `${performance.now() - started} ms`);
});

test("sk- keys with underscores are redacted to the end", () => {
  assert.equal(one("a.md", "+key sk-proj-AbCdEfGhIjKlMnOpQrSt_UvWxYz0123456789 end"), "+key ‹t› end");
  assert.equal(one("a.md", "+key sk-ant-api03-abcdefghijklmnopqrstuvwxyz_0123456789-AAAA end"), "+key ‹t› end");
});

test("keys whose credential word is joined to another word are credentials too", () => {
  const cases = [
    ["compose.yml", "+  PGPASSWORD: hunter2", "PGPASSWORD", "hunter2"],
    ["run.sh", "+export DBPASSWORD=hunter2", "DBPASSWORD", "hunter2"],
    ["config.yml", "+  SECRET_KEY_BASE: abc123def", "SECRET_KEY_BASE", "abc123def"],
    ["a.rb", '+  secret_key_base = "abc123def456"', "secret_key_base", "abc123def456"],
    ["a.js", '+const mysqlpassword = "abc123def456";', "mysqlpassword", "abc123def456"],
    ["a.js", '+const apptoken = "abc123def456";', "apptoken", "abc123def456"],
    ["a.cs", '+var clientsecret = "abc123def456";', "clientsecret", "abc123def456"],
  ];
  for (const [path, line, key, secret] of cases) {
    const out = one(path, line);
    assert.ok(out.includes(key) && !out.includes(secret) && out.includes("‹v›"), `${path}: ${out}`);
  }
  for (const line of ["+var compass = heading;", "+var bypass = true;", "+const secretaryName = \"Alice Example\";"]) assert.equal(one("a.cs", line), line, line);
});
