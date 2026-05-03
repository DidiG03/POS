import UIKit
import Capacitor

// SceneDelegate adopts the UIScene lifecycle that iOS 13+ prefers and that
// future iOS versions will require. The Capacitor 8 iOS template still ships
// with the legacy AppDelegate-only setup, so we wire it ourselves to silence
// "'UIScene' lifecycle will soon be required" and to keep behavior correct
// when iOS makes the migration mandatory.
//
// Behavior is identical to the legacy setup:
//   • The window is created here from Main.storyboard (CAPBridgeViewController)
//   • URL opens (deep links) and NSUserActivity (Universal Links) are forwarded
//     to ApplicationDelegateProxy so Capacitor plugins still receive them.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let storyboard = UIStoryboard(name: "Main", bundle: nil)
        window.rootViewController = storyboard.instantiateInitialViewController()
        self.window = window
        window.makeKeyAndVisible()

        // Forward any launch URL or user activity through Capacitor's bridge.
        if let urlContext = connectionOptions.urlContexts.first {
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                open: urlContext.url,
                options: [:]
            )
        }
        if let userActivity = connectionOptions.userActivities.first {
            _ = ApplicationDelegateProxy.shared.application(
                UIApplication.shared,
                continue: userActivity,
                restorationHandler: { _ in }
            )
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        guard let urlContext = URLContexts.first else { return }
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            open: urlContext.url,
            options: [:]
        )
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(
            UIApplication.shared,
            continue: userActivity,
            restorationHandler: { _ in }
        )
    }
}
