#!/usr/bin/env bash
# Builds the FORM//ENGINE Android wrapper APK without Gradle: aapt2 → javac → d8 → zipalign → apksigner.
#
#   ANDROID_SDK_ROOT=/path/to/sdk scripts/build-android.sh
#
# Needs: JDK 17+, Android SDK "platforms;android-34" and "build-tools;35.0.0".
# Signing key: $FE_KEYSTORE (default ~/.formengine-android/release.jks), created on first run.
# Keep that file: Android only accepts an update that is signed with the same key as the installed app.
set -euo pipefail
cd "$(dirname "$0")/.."
SDK="${ANDROID_SDK_ROOT:?set ANDROID_SDK_ROOT}"
BT="$SDK/build-tools/${FE_BUILD_TOOLS:-35.0.0}"
JAR="$SDK/platforms/android-34/android.jar"
KS="${FE_KEYSTORE:-$HOME/.formengine-android/release.jks}"
KS_PASS="${FE_KEYSTORE_PASS:-formengine}"
OUT=dist-android
rm -rf "$OUT/build" && mkdir -p "$OUT/build/res" "$OUT/build/gen" "$OUT/build/classes"

"$BT/aapt2" compile --dir android/res -o "$OUT/build/res/compiled.zip"
"$BT/aapt2" link -I "$JAR" --manifest android/AndroidManifest.xml --java "$OUT/build/gen" \
  -o "$OUT/build/unsigned.apk" "$OUT/build/res/compiled.zip" --min-sdk-version 26 --target-sdk-version 34
javac --release 8 -Xlint:-options -encoding UTF-8 -classpath "$JAR" -d "$OUT/build/classes" \
  $(find android/src "$OUT/build/gen" -name '*.java')
"$BT/d8" --release --min-api 26 --lib "$JAR" --output "$OUT/build" $(find "$OUT/build/classes" -name '*.class')
(cd "$OUT/build" && zip -q -j unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/build/unsigned.apk" "$OUT/build/aligned.apk"

if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KS_PASS" -alias formengine \
    -keyalg RSA -keysize 3072 -validity 10000 -dname "CN=FORM ENGINE, O=westkitty" >/dev/null 2>&1
  echo "Created signing key $KS (keep it to sign future updates)."
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$KS_PASS" --ks-key-alias formengine --out "$OUT/form-engine.apk" "$OUT/build/aligned.apk"
"$BT/apksigner" verify --print-certs "$OUT/form-engine.apk" | head -3
ls -l "$OUT/form-engine.apk"
