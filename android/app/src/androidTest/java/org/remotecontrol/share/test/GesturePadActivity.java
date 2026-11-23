package org.remotecontrol.share.test;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;

/** Touch target installed only in the emulator test APK. */
public class GesturePadActivity extends Activity {
  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    if (getIntent().getBooleanExtra("colorPattern", false)) {
      android.widget.LinearLayout page = new android.widget.LinearLayout(this);
      for (int color : new int[]{0xff1ac882, 0xffcc3040}) {
        android.view.View half = new android.view.View(this);
        half.setBackgroundColor(color);
        page.addView(half, new android.widget.LinearLayout.LayoutParams(0, -1, 1));
      }
      setContentView(page);
      return;
    }
    Button button = new Button(this);
    button.setText("等待電腦點擊");
    button.setOnClickListener(v -> button.setText("收到遠端點擊".contentEquals(button.getText())
        ? "收到第二次遠端點擊" : "收到遠端點擊"));
    setContentView(button);
  }
}
