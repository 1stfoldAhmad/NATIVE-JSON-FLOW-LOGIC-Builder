/**
 * Registration screen built with @expo/ui.
 *
 * The screen owns NO business logic. Pressing "Register" dispatches the
 * `form.submit` event exactly like the Expo JSON Form Builder does; the JSON
 * hook (hook.form.before-submit) runs flow.user.registration, which validates,
 * creates the user via the api.write native and emits `user.registered`.
 */

import { useState } from "react";
import { View, Text, TextInput, Button, Spinner } from "@expo/ui";
import { useEngine, useFlowState, useFlowEvent } from "vds-json-logic/expo";

export default function RegistrationScreen() {
  const engine = useEngine();
  const flowState = useFlowState("flow.user.registration");
  const [registered, setRegistered] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "Ahmad", email: "ahmad@example.com", password: "secret123", age: "25" });

  useFlowEvent("user.registered", (payload) => {
    setRegistered((payload as { userId?: string }).userId ?? "unknown");
  });

  const submit = () => {
    // This is the Form Builder's contract: one event, JSON payload.
    void engine.dispatch("form.submit", {
      formId: "registration",
      values: { ...form, age: Number(form.age) },
    });
  };

  const running = flowState.status === "running";

  return (
    <View style={{ flex: 1, padding: 24, gap: 12 }}>
      <Text variant="headlineLarge">Create account</Text>

      <TextInput value={form.name} onChangeText={(name) => setForm((f) => ({ ...f, name }))} placeholder="Name" />
      <TextInput value={form.email} onChangeText={(email) => setForm((f) => ({ ...f, email }))} placeholder="Email" />
      <TextInput
        value={form.password}
        onChangeText={(password) => setForm((f) => ({ ...f, password }))}
        placeholder="Password"
        secure
      />
      <TextInput value={form.age} onChangeText={(age) => setForm((f) => ({ ...f, age }))} placeholder="Age" />

      {running ? <Spinner /> : <Button onPress={submit}>Register</Button>}

      {flowState.status === "failed" && (
        <Text color="red">{`${flowState.error?.code}: ${flowState.error?.message}`}</Text>
      )}
      {flowState.status === "completed" && (
        <Text color="green">
          {`Registered: ${JSON.stringify(flowState.result)} (verification email for user ${registered ?? "?"})`}
        </Text>
      )}
    </View>
  );
}
