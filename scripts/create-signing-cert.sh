#!/bin/bash
# Creates OpenClean's own code-signing certificate, once.
#
# The free release is signed with this certificate instead of an Apple Developer ID. macOS ties
# permissions such as Full Disk Access to the app's signature; signing every release with the
# same certificate keeps those permissions across updates. Losing this certificate means every
# user has to grant Full Disk Access again after the next update, so back up the folder.
#
# Everything lives in its own keychain under ~/.openclean-signing; the login keychain is untouched.
set -euo pipefail

DIR="${OPENCLEAN_SIGNING_DIR:-$HOME/.openclean-signing}"
NAME="OpenClean Self-Signed Code Signing"
KEYCHAIN="$DIR/openclean-signing.keychain-db"

if [ -e "$KEYCHAIN" ]; then
  echo "A signing keychain already exists at $KEYCHAIN. Refusing to replace it." >&2
  exit 1
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
cd "$DIR"

cat > cert.cnf <<CNF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $NAME
O = OpenClean
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF

# Ten years: the certificate must outlive many releases.
openssl req -new -x509 -newkey rsa:3072 -nodes -days 3650 -sha256 -config cert.cnf -keyout key.pem -out cert.pem
P12_PASSWORD="$(openssl rand -hex 24)"
# OpenSSL 3 encrypts .p12 files with algorithms macOS's security tool cannot read; -legacy fixes that.
LEGACY=""
if openssl version | grep -q '^OpenSSL 3'; then LEGACY="-legacy"; fi
openssl pkcs12 -export $LEGACY -inkey key.pem -in cert.pem -name "$NAME" -out openclean-signing.p12 -passout "pass:$P12_PASSWORD"
KEYCHAIN_PASSWORD="$(openssl rand -hex 24)"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security set-keychain-settings "$KEYCHAIN"   # no auto-lock timeout changes beyond the default
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
security import openclean-signing.p12 -k "$KEYCHAIN" -P "$P12_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null

printf '%s' "$KEYCHAIN_PASSWORD" > keychain-password.txt
printf '%s' "$P12_PASSWORD" > p12-password.txt
chmod 600 key.pem keychain-password.txt p12-password.txt openclean-signing.p12
rm -f cert.cnf

# codesign only uses a certificate macOS trusts for code signing. This asks for your Mac password once.
echo "macOS will now ask for your password to trust this certificate for code signing."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" cert.pem

echo "Created: $DIR"
echo "Certificate SHA-1: $(openssl x509 -in cert.pem -noout -fingerprint -sha1 | cut -d= -f2)"
echo "Back up this folder somewhere safe. Never commit it."
