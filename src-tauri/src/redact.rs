//! Swaps file paths and links in a prompt for their file name and their host. A path tells the reader which
//! file the user meant, but the folders are not English: they skew the naturalness score and waste practice on
//! text that cannot be rewritten. A file name works like a proper noun and fits any position in the sentence
//! ("do we need these A.cs B.cs files"), which a placeholder such as "this file" does not. Folders, queries and
//! credentials are never kept.

/// Bump when `redact`'s output changes: `Db::open` then re-reads every source once.
pub const VERSION: i64 = 2;

/// Extensions that make a bare token such as `ReferralTable.razor` a file name.
const EXTENSIONS: [&str; 34] = [
    "cs", "cshtml", "razor", "csproj", "sln", "ts", "tsx", "js", "jsx", "mjs", "json", "rs", "toml", "py", "go",
    "java", "kt", "rb", "php", "md", "css", "scss", "html", "xml", "yml", "yaml", "sql", "txt", "log", "lock",
    "config", "env", "sh", "ps1",
];

/// Words that already introduce a noun, so a link after them needs no "this ... link" around its host.
const DETERMINERS: [&str; 11] = ["this", "that", "the", "a", "an", "these", "those", "my", "our", "your", "their"];
/// Words that already name what a link is, so the host can stand in front of them as it is.
const LINK_NOUNS: [&str; 11] = ["link", "links", "page", "site", "url", "docs", "article", "pr", "issue", "repo", "repository"];

/// Paths seen so far in one message and the name each one was given, so two different paths with the same
/// file name do not collapse into "X.cs, X.cs and X.cs".
#[derive(Default)]
struct Names(Vec<(String, String)>);

impl Names {
    fn name_for(&mut self, path: &str) -> String {
        let key = path.strip_prefix('@').unwrap_or(path).replace('\\', "/");
        if let Some((_, name)) = self.0.iter().find(|(k, _)| *k == key) {
            return name.clone();
        }
        let base = file_name(path);
        let used = |name: &str| self.0.iter().any(|(_, n)| n == name);
        let name = (1..).map(|n| if n == 1 { base.clone() } else { numbered(&base, n) }).find(|c| !used(c)).unwrap_or_else(|| base.clone());
        self.0.push((key, name.clone()));
        name
    }
}

fn numbered(base: &str, n: usize) -> String {
    match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}{n}.{ext}"),
        _ => format!("{base}{n}"),
    }
}

pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut prev = String::new();
    let mut names = Names::default();
    while !rest.is_empty() {
        let spaces = rest.len() - rest.trim_start().len();
        out.push_str(&rest[..spaces]);
        rest = &rest[spaces..];
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let token = &rest[..end];
        rest = &rest[end..];
        let next = word(rest.trim_start().split(char::is_whitespace).next().unwrap_or(""));
        out.push_str(&redact_token(token, &prev, &next, &mut names));
        prev = word(token);
    }
    out
}

fn word(token: &str) -> String {
    token.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

fn redact_token(token: &str, prev: &str, next: &str, names: &mut Names) -> String {
    let core = token.trim_start_matches(|c| "(\"'`[{<".contains(c));
    let lead = &token[..token.len() - core.len()];
    let core = core.trim_end_matches(|c| ")\"'`]}>.,;:?!".contains(c));
    let tail = &token[lead.len() + core.len()..];
    if let Some(rest) = core.strip_prefix("https://").or_else(|| core.strip_prefix("http://")) {
        let introduced = DETERMINERS.contains(&prev) || LINK_NOUNS.contains(&next);
        let text = match (host(rest), introduced) {
            (Some(h), true) => h,
            (Some(h), false) => format!("this {h} link"),
            (None, true) => "link".to_string(),
            (None, false) => "this link".to_string(),
        };
        return format!("{lead}{text}{tail}");
    }
    let bare = without_location(core);
    if is_path(&bare) {
        return format!("{lead}{}{tail}", names.name_for(&bare));
    }
    token.to_string()
}

/// The site of a link: no path, query, credentials or port.
fn host(rest: &str) -> Option<String> {
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = authority.split(':').next().unwrap_or("");
    (!host.is_empty()).then(|| host.to_string())
}

/// The last segment of a path, with no folders in front.
fn file_name(path: &str) -> String {
    let body = path.strip_prefix('@').unwrap_or(path);
    body.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(body).to_string()
}

/// `Facade.cs:64`, `Facade.cs:64:9` and `Facade.cs#L64` point at a line of the same file.
fn without_location(core: &str) -> String {
    let base = core.split("#L").next().unwrap_or(core);
    let mut parts: Vec<&str> = base.split(':').collect();
    while parts.len() > 1 && parts.last().is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())) {
        parts.pop();
    }
    parts.join(":")
}

fn is_path(core: &str) -> bool {
    let at = core.starts_with('@');
    let body = core.strip_prefix('@').unwrap_or(core);
    if !body.chars().any(char::is_alphabetic) {
        return false;
    }
    let bytes = body.as_bytes();
    let drive = bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/');
    let separators = body.chars().filter(|c| *c == '/' || *c == '\\').count();
    let relative = ["./", "../", ".\\", "..\\", "~/", "~\\"].iter().any(|p| body.starts_with(p));
    let last = body.rsplit(['/', '\\']).next().unwrap_or(body);
    // A bare `node.js` or `Next.js` is a product name, so `.js` only counts with a folder in front.
    let file = last.rsplit_once('.').is_some_and(|(stem, ext)| {
        let ext = ext.to_ascii_lowercase();
        !stem.is_empty() && EXTENSIONS.contains(&ext.as_str()) && (ext != "js" || separators >= 1)
    });
    // `and/or` and `yes/no` are words; a path has a file extension or goes at least two folders deep.
    drive || relative || file || (at && separators >= 1) || (separators >= 2 && (body.starts_with('/') || body.starts_with('\\')))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(out: &str) {
        for bad in ["/", "\\", "token", "secret", "this file"] {
            assert!(!out.contains(bad), "{out} contains {bad}");
        }
    }

    #[test]
    fn replaces_the_paths_with_file_names_and_keeps_the_sentence() {
        let expected = "do we need these A.cs B.cs files refering to the C.cs? is this necessary?";
        let unix = "do we need these @src/Billing/A.cs @src/Billing/B.cs files refering to the @src/Billing/Mappers/C.cs? is this necessary?";
        let win = r"do we need these C:\Projects\x\A.cs C:\Projects\x\B.cs files refering to the C:\Projects\x\Mappers\C.cs? is this necessary?";
        assert_eq!(redact(unix), expected);
        assert_eq!(redact(win), expected);
    }

    #[test]
    fn handles_every_shape_of_path() {
        for (path, name) in [
            (r"C:\acme\shop\Program.cs", "Program.cs"),
            ("C:/acme/shop", "shop"),
            ("./src/app.ts", "app.ts"),
            ("../shared/types.ts", "types.ts"),
            ("~/projects/cadence", "cadence"),
            ("/usr/local/bin", "bin"),
            ("@src/components", "components"),
            ("@README.md", "README.md"),
            ("ReferralTable.razor", "ReferralTable.razor"),
            ("src/main.rs", "main.rs"),
            ("CreditCardFacade.cs:64", "CreditCardFacade.cs"),
            ("CreditCardFacade.cs:64:9", "CreditCardFacade.cs"),
            ("package.json#L12", "package.json"),
        ] {
            let out = redact(&format!("look at {path} please"));
            assert_eq!(out, format!("look at {name} please"), "{path}");
            clean(&out);
            assert_eq!(redact(&out), out, "{path}");
        }
    }

    #[test]
    fn a_trailing_slash_does_not_hide_the_folder_name() {
        assert_eq!(file_name("src/x/"), "x");
    }

    #[test]
    fn keeps_the_punctuation_and_position_around_a_path() {
        assert_eq!(redact("Is `src/app.ts`, or (Facade.cs) wrong?"), "Is `app.ts`, or (Facade.cs) wrong?");
        assert_eq!(redact("did you change src/app.ts?"), "did you change app.ts?");
        assert_eq!(redact("src/app.ts is broken"), "app.ts is broken");
        assert_eq!(redact("check a/b/X.cs, a/b/Y.cs and a/c/Z.cs"), "check X.cs, Y.cs and Z.cs");
    }

    #[test]
    fn replaces_links_with_their_host() {
        for (text, expected) in [
            ("see https://example.com/docs/api?x=1 for details", "see this example.com link for details"),
            ("check this https://github.com/o/r/pull/12 PR", "check this github.com PR"),
            ("read https://github.com/o/r issue", "read github.com issue"),
            ("read the https://learn.microsoft.com/aspnet/core page", "read the learn.microsoft.com page"),
            ("read https://", "read this link"),
            ("(https://user:secret@internal.corp:8443/x?token=abc).", "(this internal.corp link)."),
        ] {
            let out = redact(text);
            assert_eq!(out, expected);
            clean(&out);
            assert_eq!(redact(&out), out);
        }
    }

    #[test]
    fn different_paths_with_one_file_name_stay_apart_and_the_same_path_stays_the_same() {
        let out = redact(r"compare src/Core/S.cs, src/UI/S.cs and C:\x\Api\S.cs, then src/UI/S.cs again");
        assert_eq!(out, "compare S.cs, S2.cs and S3.cs, then S2.cs again");
        assert_eq!(redact(&out), out);
        assert_eq!(redact("src/app.ts and src/app.ts"), "app.ts and app.ts");
    }

    #[test]
    fn leaves_words_and_numbers_alone() {
        for text in [
            "should it be client/server or and/or yes/no?",
            "we shipped 3/4 of it on 05/10/2024, i.e. mostly",
            "use w/o the flag, e.g. node.js is fine",
            "send it to alex@acme.com tomorrow",
            "/compact the context first",
            "see github.com and Program.cs",
        ] {
            assert_eq!(redact(text), text);
        }
    }

    #[test]
    fn keeps_line_breaks_and_is_idempotent() {
        let once = redact("first line\n  see src/app.ts\n\nsecond line");
        assert_eq!(once, "first line\n  see app.ts\n\nsecond line");
        assert_eq!(redact(&once), once);
    }
}
