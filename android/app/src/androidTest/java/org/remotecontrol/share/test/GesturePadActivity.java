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
      setContentView(new android.view.View(this) {
        android.graphics.Bitmap texture;
        final android.graphics.Paint paint = new android.graphics.Paint();
        @Override protected void onSizeChanged(int w, int h, int oldWidth, int oldHeight) {
          if (texture != null) texture.recycle();
          if (w <= 0 || h <= 0) return;
          int[] pixels = new int[w * h];
          java.util.Random random = new java.util.Random(42);
          for (int i = 0; i < pixels.length; i++) pixels[i] = 0xff000000 | random.nextInt(0x1000000);
          texture = android.graphics.Bitmap.createBitmap(pixels, w, h, android.graphics.Bitmap.Config.ARGB_8888);
        }
        @Override protected void onDraw(android.graphics.Canvas canvas) {
          if (texture != null) canvas.drawBitmap(texture, 0, 0, null);
          paint.setColor(0xff1ac882);
          canvas.drawRect(0, getHeight()*.32f, getWidth()/2f, getHeight()*.65f, paint);
          paint.setColor(0xffcc3040);
          canvas.drawRect(getWidth()/2f, getHeight()*.32f, getWidth(), getHeight()*.65f, paint);
        }
      });
      return;
    }
    Button button = new Button(this);
    button.setText("等待電腦點擊");
    button.setOnClickListener(v -> button.setText("收到遠端點擊".contentEquals(button.getText())
        ? "收到第二次遠端點擊" : "收到遠端點擊"));
    setContentView(button);
  }
}
