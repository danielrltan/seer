#!/bin/bash
# Creates "Seer Local Signing", a code-signing certificate that exists only in this Mac's login keychain, for
# scripts/build-app.sh. macOS ties Screen Recording and Accessibility to how an app is signed: signed ad hoc, every
# rebuild looks like a new app and both permissions are asked for again; signed with this certificate, they stay.
# It is self-signed (not issued by Apple), so Gatekeeper does not run Apple's notarization check on it, which is
# what flagged an Apple Development build as malware. Only codesign may use its key.
# Remove it any time: Keychain Access > login > My Certificates > Seer Local Signing > Delete.
set -euo pipefail
NAME="Seer Local Signing"
if security find-certificate -c "$NAME" >/dev/null 2>&1; then echo "$NAME already exists"; exit 0; fi
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat > "$T/ext.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3
[dn]
CN = $NAME
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
PW=$(openssl rand -hex 16)
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/key.pem" -out "$T/cert.pem" -days 3650 -config "$T/ext.cnf" 2>/dev/null
openssl pkcs12 -export -legacy -inkey "$T/key.pem" -in "$T/cert.pem" -name "$NAME" -out "$T/seer.p12" -passout "pass:$PW" 2>/dev/null
security import "$T/seer.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$PW" -T /usr/bin/codesign
echo "created $NAME (valid 10 years, in the login keychain)"
