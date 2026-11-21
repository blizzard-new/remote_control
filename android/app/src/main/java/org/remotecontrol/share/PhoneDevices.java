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
      context.startActivity(new android.content.Intent(context, ShareActivity.class)
        .addFlags(android.content.Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)));
  }

  @JavascriptInterface
  public String name() {
    return Build.MODEL;
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
          else if (action.equals("save")) {
            String dial = item.getString("dial"),
                name = item.getString("name"),
                address = item.getString("address");
            if (!dial.matches("[A-Za-z0-9_-]{32}")
                || name.trim().isEmpty()
                || name.length() > 64
                || address.length() > 512) throw new IllegalArgumentException();
            DesktopOrigin.viewerUrl(address);
            if (!entries.has(listen) && entries.length() >= 16) throw new IllegalStateException();
            entries.put(
                listen,
                new JSONObject()
                    .put("listen", listen)
                    .put("dial", dial)
                    .put("name", name)
                    .put("address", address)
                    .put("grant", item.optString("grant", "")));
          } else throw new IllegalArgumentException();
          if (!preferences.edit().putString("contacts", entries.toString()).commit())
            throw new IllegalStateException();
          if (action.equals("forget"))
            new android.os.Handler(android.os.Looper.getMainLooper())
                .post(
                    () -> {
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
