# Phone control

Phone control is an optional HTTPS remote for one supported app launch, volume change, or timer at a time. Start it explicitly from **Work tools → Phone remote**. It never starts with Olanga, opens an internet tunnel, changes your firewall, or starts listening on every network interface.

Choose a private IPv4 address on the computer and a matching PEM HTTPS certificate/private key using the native file pickers. A loopback address is useful for testing on the computer but cannot be reached from a phone. Connect the phone to the same trusted local network, open the displayed HTTPS URL, and pair with the six-digit code shown in Olanga.

The code expires after five minutes, works once, and locks after five incorrect attempts. A paired phone expires after 30 minutes. The listener closes after one hour or when you select **Stop** or quit Olanga. Starting it again replaces the old session. **Unpair this phone** revokes the phone and requests cancellation of its pending action; completed actions remain in place.

## HTTPS certificate setup on Windows

This HTTPS certificate protects the connection between your phone and computer. It is separate from the publisher certificate used to sign a Windows installer. You do not need a paid Windows code-signing certificate for this feature.

An existing certificate is suitable if its Subject Alternative Name contains the selected private IP, it is currently valid, and its unencrypted PEM private key matches. RSA keys must contain at least 2048 bits. Keep the private key on the computer; never copy it to the phone or commit it to the project.

For a personal local certificate, run the following in **PowerShell 7 on Windows**. Replace the sample address with the address you will select in Olanga. The example writes the files into your local application-data folder and creates a certificate in your personal certificate store; it does not install that certificate as a trusted root.

```powershell
$olangaAddress = '192.168.1.42'
$olangaTlsDirectory = Join-Path $env:LOCALAPPDATA 'Olanga\phone-tls'
New-Item -ItemType Directory -Path $olangaTlsDirectory -Force | Out-Null
$olangaCertificate = New-SelfSignedCertificate -Type Custom `
  -Subject 'CN=Olanga phone control' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -TextExtension @(
    "2.5.29.17={text}IPAddress=$olangaAddress",
    '2.5.29.37={text}1.3.6.1.5.5.7.3.1'
  ) `
  -NotAfter (Get-Date).AddDays(30)

# Reopen the certificate locally if the PKI module used a compatibility session.
$olangaCertificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($olangaCertificate.Thumbprint)"
$olangaPrivateKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($olangaCertificate)
try {
  [IO.File]::WriteAllText((Join-Path $olangaTlsDirectory 'certificate.pem'), $olangaCertificate.ExportCertificatePem())
  [IO.File]::WriteAllText((Join-Path $olangaTlsDirectory 'private-key.pem'), $olangaPrivateKey.ExportPkcs8PrivateKeyPem())
  [IO.File]::WriteAllBytes((Join-Path $olangaTlsDirectory 'certificate.cer'), $olangaCertificate.RawData)
} finally {
  $olangaPrivateKey.Dispose()
}
```

Microsoft documents the [IP-address SAN and certificate creation parameters](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate) and the [.NET PEM private-key export method](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.asymmetricalgorithm.exportpkcs8privatekeypem). PowerShell 5.1 does not provide the modern .NET PEM export methods used above.

Select `certificate.pem` and `private-key.pem` in Olanga. Transfer **only** `certificate.cer` to your own phone through a channel you trust. Compare its SHA-256 fingerprint with the value displayed in Olanga before installing or trusting it. Follow the phone operating system’s certificate-trust settings. Do not use an unrelated certificate or bypass a fingerprint mismatch. Trusting a locally created certificate is a separate user choice; Olanga does not modify either device’s certificate trust settings.

If the computer’s private IP changes, create a new certificate for the new address. If the phone cannot reach the URL, check that both devices share the same local network, that Wi-Fi client isolation is disabled where appropriate, and that your firewall allows Olanga on that private network. Olanga does not create firewall exceptions automatically.

## Commands and dictation

Examples:

- `Open Spotify`
- `Set volume to 30 percent`
- `Mute system volume`
- `Set a timer for five minutes`

The server accepts a single supported fast command and sends the already parsed action to Olanga’s existing controller. Shell commands, arbitrary app names, app closing, browsing files, model requests, mute toggles, and compound commands are rejected. This remote cannot grant a desktop automation session or execute text returned by a model.

Typing is the default. The optional **Dictate** button uses the phone browser’s speech-recognition service, which may send audio to that browser provider and may require a trusted HTTPS connection. Availability depends on the phone and browser. Review its transcript and press **Send command** explicitly. Keyboard dictation remains available if the browser does not support web speech recognition.

Each sent command has a random request identifier. A connection failure offers **Check the same request again**, which retrieves the existing result without replaying the action. Do not reload the page and send a fresh command when its outcome is uncertain; first check Olanga on the computer. A timeout or interrupted session cannot undo an already completed action.

## Verification scope

Automated fixtures use an actual HTTPS listener with certificate verification enabled and a locally generated test certificate. They cover pairing, expiry, attempt limits, host/origin checks, CSRF, the command allowlist, simultaneous requests, deduplication, cancellation, timeout, restart, and mismatched keys. Test certificates and private keys are created in a temporary directory and removed after the tests; no test private key is committed.

Those fixtures do not establish compatibility with every mobile browser, microphone, certificate-trust UI, home router, or firewall. A physical-phone check is still required for a particular device. The protocol tests need OpenSSL for temporary test-certificate generation; Git for Windows includes it. OpenSSL is not a runtime dependency of the app.
