package com.codeorbit.waiter;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // super.onCreate() starts loading the WebView asynchronously, so the
        // interface is in place before the waiter JS runs.
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge()
                .getWebView()
                .addJavascriptInterface(new NativeTapHaptics(this), "PosNativeHaptics");
        }
    }
}
