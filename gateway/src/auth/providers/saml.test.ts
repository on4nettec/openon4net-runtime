import { describe, it, expect } from 'vitest';
import { createSamlClient, extractIdentityFromAssertion } from './saml.js';

// A syntactically-plausible but self-signed/unsigned SAMLResponse — proves
// the ACS path rejects it, without needing a real IdP to produce a validly
// signed one. A full valid-signature round trip needs a real IdP (Okta/
// Azure AD trial) and isn't automatable here — same blocked-in-CI category
// as RT-005 (Telegram token) and RT-017 (OAuth against a live Google/GitHub
// app), see docs/spect/DONE.md.
const UNSIGNED_SAML_RESPONSE = Buffer.from(
  `<?xml version="1.0"?>
  <samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_1" Version="2.0" IssueInstant="2026-01-01T00:00:00Z">
    <saml:Issuer>https://idp.example.com</saml:Issuer>
    <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
    <saml:Assertion ID="_2" Version="2.0" IssueInstant="2026-01-01T00:00:00Z">
      <saml:Issuer>https://idp.example.com</saml:Issuer>
      <saml:Subject><saml:NameID>person@example.com</saml:NameID></saml:Subject>
      <saml:AttributeStatement>
        <saml:Attribute Name="email"><saml:AttributeValue>person@example.com</saml:AttributeValue></saml:Attribute>
      </saml:AttributeStatement>
    </saml:Assertion>
  </samlp:Response>`,
  'utf8',
).toString('base64');

const FAKE_IDP_CERT =
  'MIIBrTCCARYCCQCUeIm+H6WeKzANBgkqhkiG9w0BAQsFADAeMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGT3ZlcXV1MB4XDTI2MDEwMTAwMDAwMFoXDTI3MDEwMTAwMDAwMFowHjELMAkGA1UEBhMCVVMxDzANBgNVBAoMBk92ZXF1dTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEA1L7Y2Y5X1YkV2fZ0J8n8fXFRZ9r3W0v9d3s0PLjfXfF5J4vXeXFsBn0YFf3YV3aJUE9v0Yb9hVfF3Yb0Y3vZbZ9V0jvUYbZfV3Y3XvYYb0Y9VbfZY3vYbZ9V0jvUYbZfV3Y3XvYYb0Y9VbfZY3vwIDAQABMA0GCSqGSIb3DQEBCwUAA4GBAA==';

describe('createSamlClient + extractIdentityFromAssertion', () => {
  it('createSamlClient() builds a node-saml client pointed at the given IdP', () => {
    const saml = createSamlClient('https://sp.example.com', 'https://idp.example.com/sso', FAKE_IDP_CERT, 'https://gateway.example.com');
    expect(saml).toBeDefined();
  });

  it('extractIdentityFromAssertion() rejects an unsigned assertion (wantAssertionsSigned)', async () => {
    const saml = createSamlClient('https://sp.example.com', 'https://idp.example.com/sso', FAKE_IDP_CERT, 'https://gateway.example.com');

    await expect(extractIdentityFromAssertion(saml, UNSIGNED_SAML_RESPONSE)).rejects.toThrow('SAML assertion validation failed');
  });

  it('extractIdentityFromAssertion() rejects garbage input that is not valid SAML XML at all', async () => {
    const saml = createSamlClient('https://sp.example.com', 'https://idp.example.com/sso', FAKE_IDP_CERT, 'https://gateway.example.com');
    const garbage = Buffer.from('not xml at all').toString('base64');

    await expect(extractIdentityFromAssertion(saml, garbage)).rejects.toThrow('SAML assertion validation failed');
  });
});
