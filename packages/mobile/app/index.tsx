// Velbaz Control (the standalone gate-toggle app) has been retired — the
// waitlist/launch-gate switch now lives only in the web admin panel, behind a
// real admin session (see packages/web: POST/GET /admin/launch-gate/mode).
// This screen is a placeholder scaffold for whatever comes next.
import { StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/use-colors";
import { usePing } from "@/queries/ping";

export default function IndexScreen() {
  const colors = useColors();
  const { data } = usePing();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.foreground }]}>Velbaz</Text>
      <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
        {data ? "Connecté au serveur." : "…"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
  },
  subtitle: {
    fontSize: 14,
  },
});
