package org.remotecontrol.share;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.webkit.JavascriptInterface;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Shared only with the packaged local viewer and the foreground screen-sharing service. */
public final class PhoneDevices {
  private static final Object LOCK = new Object();
  private final SharedPreferences preferences;
  private final Context context;

  PhoneDevices(Context context) {
    this.context=context;
    preferences = context.getSharedPreferences("paired-devices", Context.MODE_PRIVATE);
  }

  @JavascriptInterface public void openHost() {
    new android.os.Handler(android.os.Looper.getMainLooper()).post(() ->
      context.startActivity(new android.content.Intent(context, ShareHostActivity.class)
        .addFlags(android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)));
  }

  @JavascriptInterface
  public String name() {
    return Build.MODEL;
  }

  @JavascriptInterface
  public void setDisplayName(String name) {
    if (name != null && name.length() <= 48)
      preferences.edit().putString("display-name", name.trim()).apply();
  }

  String displayName() {
    String label = preferences.getString("display-name", "");
    return label.isEmpty() ? name() : label;
  }

  static String resumeProof(String secret, String role, String challenge) throws Exception {
    javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
    mac.init(new javax.crypto.spec.SecretKeySpec(android.util.Base64.decode(secret, android.util.Base64.URL_SAFE), "HmacSHA256"));
    return PinDirectory.b64(mac.doFinal(("uniway-resume/v1/" + role + "/" + challenge)
        .getBytes(java.nio.charset.StandardCharsets.UTF_8)));
  }

  String resumeAnswer(JSONArray offers, String address, String challenge) throws Exception {
    if (offers == null || offers.length() == 0 || offers.length() > 16) return null;
    List<JSONObject> candidates = list();
    candidates.sort(java.util.Comparator.comparingInt(pair ->
        "control".equals(pair.optString("grant")) ? 0 : "view".equals(pair.optString("grant")) ? 1 : 2));
    for (JSONObject pair : candidates) {
      if (!address.equals(pair.optString("address"))) continue;
      String expected = resumeProof(pair.getString("listen"), "controller", challenge);
      for (int i = 0; i < offers.length(); i++) {
        if (expected.equals(offers.optString(i)))
          return resumeProof(pair.getString("dial"), "host", challenge);
      }
    }
    return null;
  }

  @JavascriptInterface
  public String sessionState() throws org.json.JSONException {
    CaptureService.Status state = CaptureService.status;
    PhoneShare host = CaptureService.online;
    JSONArray peers = new JSONArray();
    if (state.running && host != null) host.appendConnected(peers);
    return new JSONObject().put("peers", peers).put("lan", state.lanViewers)
        .put("listening", state.running && (state.lanViewers >= 0 ||
            (host != null && !host.invitation().isEmpty()))).toString();
  }

  @JavascriptInterface
  public String update(String action, String raw) {
    synchronized (LOCK) {
      try {
        JSONObject entries = new JSONObject(preferences.getString("contacts", "{}"));
        if (!action.equals("list")) {
          JSONObject item = new JSONObject(raw);
          String listen = item.getString("listen");
          if (!listen.matches("[A-Za-z0-9_-]{32}")) throw new IllegalArgumentException();
          if (action.equals("forget")) entries.remove(listen);
          else if (action.equals("identify") || action.equals("save")) {
            String dial = item.getString("dial"),
                name = item.getString("name"),
                address = item.getString("address");
            if (!dial.matches("[A-Za-z0-9_-]{32}")
                || name.trim().isEmpty()
                || name.length() > 64
                || address.length() > 512) throw new IllegalArgumentException();
            DesktopOrigin.viewerUrl(address);
            if (!entries.has(listen) && entries.length() >= 16) throw new IllegalStateException();
            if (action.equals("identify")) {
              JSONObject existing = entries.getJSONObject(listen);
              if (!existing.getString("dial").equals(dial) || !existing.getString("address").equals(address))
                throw new IllegalArgumentException();
              item.put("grant", existing.optString("grant"));
            }
            entries.put(
                listen,
                new JSONObject()
                    .put("listen", listen)
                    .put("dial", dial)
                    .put("name", name)
                    .put("platform", item.optString("platform", ""))
                    .put("address", address)
                    .put("grant", item.optString("grant", "")));
          } else throw new IllegalArgumentException();
          if (!preferences.edit().putString("contacts", entries.toString()).commit())
            throw new IllegalStateException();
          if (action.equals("forget"))
            new android.os.Handler(android.os.Looper.getMainLooper())
                .post(
                    () -> {
                      PhoneShare.forgetPreview(listen);
                      PhoneShare active = CaptureService.online;
                      if (active != null) active.forget(listen);
                    });
        }
        JSONArray result = new JSONArray();
        java.util.Iterator<String> keys = entries.keys();
        while (keys.hasNext()) result.put(entries.getJSONObject(keys.next()));
        return result.toString();
      } catch (Exception error) {
        return "null";
      }
    }
  }

  List<JSONObject> list() throws Exception {
    JSONArray items = new JSONArray(update("list", "{}"));
    List<JSONObject> result = new ArrayList<>();
    for (int i = 0; i < items.length(); i++) result.add(items.getJSONObject(i));
    return result;
  }
}
