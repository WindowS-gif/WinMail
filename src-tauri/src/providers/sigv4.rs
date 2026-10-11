use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

type HmacSha256 = Hmac<Sha256>;

/// Minimal AWS Signature V4 implementation for read-only AWS API calls.
///
/// Only what we need for SES v2 endpoints (`email.<region>.amazonaws.com`):
/// GET/POST requests, single-region, no session token, deterministic header set.
pub struct SigV4Request {
    pub method: &'static str,
    pub host: String,
    pub path: String,
    pub query: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub region: String,
    pub service: String,
}

#[derive(Debug, Clone)]
pub struct SignedHeaders {
    pub authorization: String,
    pub amz_date: String,
    pub content_sha256: String,
}

pub fn sign(
    req: &SigV4Request,
    access_key: &str,
    secret_key: &str,
    now: DateTime<Utc>,
) -> SignedHeaders {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();

    let payload_hash = hex::encode(Sha256::digest(&req.body));

    let canonical_query = req
        .query
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        req.host, payload_hash, amz_date
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        req.method, req.path, canonical_query, canonical_headers, signed_headers, payload_hash
    );

    let canonical_request_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));

    let credential_scope = format!("{}/{}/{}/aws4_request", date_stamp, req.region, req.service);

    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date, credential_scope, canonical_request_hash
    );

    let k_date = hmac_sha256(
        format!("AWS4{secret_key}").as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, req.region.as_bytes());
    let k_service = hmac_sha256(&k_region, req.service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"aws4_request");

    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key, credential_scope, signed_headers, signature
    );

    SignedHeaders {
        authorization,
        amz_date,
        content_sha256: payload_hash,
    }
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn uri_encode(value: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for &b in value.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-' | b'~' | b'.' => {
                out.push(b as char);
            }
            b'/' if !encode_slash => out.push('/'),
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn uri_encode_basics() {
        assert_eq!(uri_encode("abc 123", true), "abc%20123");
        assert_eq!(uri_encode("a/b", false), "a/b");
        assert_eq!(uri_encode("a/b", true), "a%2Fb");
        assert_eq!(uri_encode("~._-AZ", true), "~._-AZ");
    }

    #[test]
    fn sign_produces_well_formed_authorization() {
        // Deterministic timestamp → deterministic signature. We assert the
        // overall shape and that the credential scope follows the
        // `date/region/service/aws4_request` pattern documented by AWS.
        let now = chrono::Utc.with_ymd_and_hms(2024, 1, 2, 3, 4, 5).unwrap();
        let req = SigV4Request {
            method: "GET",
            host: "email.eu-west-3.amazonaws.com".into(),
            path: "/v2/email/account".into(),
            query: BTreeMap::new(),
            body: Vec::new(),
            region: "eu-west-3".into(),
            service: "ses".into(),
        };
        let signed = sign(&req, "AKIA-TEST", "super-secret", now);
        assert_eq!(signed.amz_date, "20240102T030405Z");
        assert!(signed
            .authorization
            .starts_with("AWS4-HMAC-SHA256 Credential=AKIA-TEST/20240102/eu-west-3/ses/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="));
        // SHA-256 hex digest is 64 chars long.
        let sig_part = signed.authorization.rsplit("Signature=").next().unwrap();
        assert_eq!(sig_part.len(), 64);
        assert!(sig_part.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn sign_is_deterministic() {
        let now = chrono::Utc.with_ymd_and_hms(2024, 1, 2, 3, 4, 5).unwrap();
        let req = SigV4Request {
            method: "POST",
            host: "email.eu-west-3.amazonaws.com".into(),
            path: "/v2/email/outbound-emails".into(),
            query: BTreeMap::new(),
            body: br#"{"hi":1}"#.to_vec(),
            region: "eu-west-3".into(),
            service: "ses".into(),
        };
        let a = sign(&req, "AKIA", "S", now);
        let b = sign(&req, "AKIA", "S", now);
        assert_eq!(a.authorization, b.authorization);
        assert_eq!(a.content_sha256, b.content_sha256);
    }
}
