package com.codeorbit.waiter;

import android.content.Context;
import android.os.Build;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.webkit.JavascriptInterface;

/**
 * Direct WebView bridge so a tap can buzz without waiting on the Capacitor
 * plugin hop. Samsung tablets often ignore {@code VibrationEffect} waveforms
 * used by {@code Haptics.impact()}; a short one-shot with USAGE_TOUCH is
 * what actually spins the Tab A9 motor.
 */
public final class NativeTapHaptics {

    private static final int TAP_MS = 40;
    private final Vibrator vibrator;

    NativeTapHaptics(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager manager =
                (VibratorManager) context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            this.vibrator = manager != null ? manager.getDefaultVibrator() : null;
        } else {
            this.vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
        }
    }

    @JavascriptInterface
    public void tap() {
        if (vibrator == null || !vibrator.hasVibrator()) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                VibrationEffect effect =
                    VibrationEffect.createOneShot(TAP_MS, VibrationEffect.DEFAULT_AMPLITUDE);
                if (Build.VERSION.SDK_INT >= 33) {
                    vibrator.vibrate(
                        effect,
                        VibrationAttributes.createForUsage(VibrationAttributes.USAGE_TOUCH)
                    );
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    vibrator.vibrate(
                        effect,
                        new VibrationAttributes.Builder()
                            .setUsage(VibrationAttributes.USAGE_TOUCH)
                            .build()
                    );
                } else {
                    vibrator.vibrate(effect);
                }
            } else {
                vibrator.vibrate(TAP_MS);
            }
        } catch (Throwable ignored) {
            // No motor, or OEM blocked the call — fail quiet.
        }
    }
}
