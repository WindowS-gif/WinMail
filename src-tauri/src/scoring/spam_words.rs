use once_cell::sync::Lazy;
use regex::Regex;

static PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    [
        r"(?i)\bgratuit(e?s?)?\b",
        r"(?i)\bsans frais\b",
        r"(?i)\bargent facile\b",
        r"(?i)\bgagnez?\b",
        r"(?i)\bcash\b",
        r"(?i)\brevenu passif\b",
        r"(?i)\brichesse\b",
        r"(?i)\bget paid\b",
        r"(?i)\bmake money\b",
        r"(?i)\bfree money\b",
        r"(?i)\binstant cash\b",
        r"(?i)\bcredit card\b",
        r"(?i)\bno credit check\b",
        r"(?i)\bloan\b",
        r"(?i)\bmortgage\b",
        r"(?i)\brefinanc",
        r"(?i)\bdebt\b",
        r"(?i)\binvestissement garanti\b",
        r"(?i)\burgent(e?)\b",
        r"(?i)\bact now\b",
        r"(?i)\bagissez maintenant\b",
        r"(?i)\blimited time\b",
        r"(?i)\boffre limit[eé]e\b",
        r"(?i)\bexpires?\b",
        r"(?i)\bexpire bient[oô]t\b",
        r"(?i)\blast chance\b",
        r"(?i)\bderni[eè]re chance\b",
        r"(?i)\bfinal notice\b",
        r"(?i)\bdernier avis\b",
        r"(?i)\bdon't miss\b",
        r"(?i)\bne manquez pas\b",
        r"(?i)\btoday only\b",
        r"(?i)\baujourd'hui seulement\b",
        r"(?i)\bgaranti\b",
        r"(?i)\b100%? (gratuit|free|garanti)\b",
        r"(?i)\bno risk\b",
        r"(?i)\bsans risque\b",
        r"(?i)\bpromise\b",
        r"(?i)\bje vous promets\b",
        r"(?i)\bmiracl",
        r"(?i)\bincroyable\b",
        r"(?i)\bincredibl",
        r"(?i)\bamazing\b",
        r"(?i)\bphenomenal\b",
        r"(?i)\bexclusiv",
        r"(?i)\bsecret\b",
        r"(?i)\bperte de poids\b",
        r"(?i)\blose weight\b",
        r"(?i)\bmaigrir\b",
        r"(?i)\bbrûle-graisse\b",
        r"(?i)\bfat burner\b",
        r"(?i)\banti-aging\b",
        r"(?i)\banti.?âge\b",
        r"(?i)\bcure\b",
        r"(?i)\bremède\b",
        r"(?i)\bpill\b",
        r"(?i)\bsupplement\b",
        r"(?i)\bverif(y|ier)\b",
        r"(?i)\bv[eé]rifiez?\b",
        r"(?i)\bconfirm(er)?\b",
        r"(?i)\bsuspended\b",
        r"(?i)\bsuspendu\b",
        r"(?i)\bupdate (your|your account)\b",
        r"(?i)\bclick (here|below)\b",
        r"(?i)\bcliquez ici\b",
        r"(?i)\bpassword\b",
        r"(?i)\bmot de passe\b",
        r"(?i)\baccount (suspended|compromised)\b",
        r"(?i)\bcompte (suspendu|compromis)\b",
        r"(?i)\bnot spam\b",
        r"(?i)\bceci n'est pas du spam\b",
        r"(?i)\bunsubscribe\b",
        r"(?i)\bse d[eé]sabonner\b",
        r"(?i)\bremove me\b",
        r"(?i)\bopt.?out\b",
        r"(?i)\bcasino\b",
        r"(?i)\bpoker\b",
        r"(?i)\bjackpot\b",
        r"(?i)\bloterie\b",
        r"(?i)\blottery\b",
        r"(?i)\byou (have )?(won|win)\b",
        r"(?i)\bvous avez gagn[eé]\b",
        r"(?i)\bxxx\b",
        r"(?i)\badult(e)?\b",
        r"(?i)\bporn",
        r"(?i)\bsex\b",
        r"(?i)\berotic",
        r"\$\$\$",
        r"!!!+",
        r"\bFREE\b",
        r"\bGRATUIT\b",
        r"\bURGENT\b",
    ]
    .iter()
    .map(|p| Regex::new(p).expect("valid spam regex"))
    .collect()
});

pub fn analyze(text: &str) -> (usize, Vec<String>) {
    let mut found = Vec::new();
    for pattern in PATTERNS.iter() {
        if let Some(m) = pattern.find(text) {
            let value = m.as_str().to_string();
            if !found.contains(&value) {
                found.push(value);
            }
        }
    }
    (found.len(), found)
}
