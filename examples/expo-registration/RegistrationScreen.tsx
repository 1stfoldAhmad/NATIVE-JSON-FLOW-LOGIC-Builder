/**
 * Illustrative Expo screen (not compiled by this package — it runs inside the
 * host Expo app). Shows the first runtime target: an @expo/ui screen driving a
 * JSON flow through the vds-json-logic/expo hooks.
 *
 * The screen owns NO business logic: validation, eligibility, account creation
 * and notifications all live in examples/registration/*.json.
 */

import { useState } from "react";
import { View, Text, TextInput, Button, Spinner } from "@expo/ui";
import {
  useFlow,
  useFlowEvent,
  useAppLifecycle,
} from "vds-json-logic/expo";

export default function RegistrationScreen() {
  useAppLifecycle(); // dispatches app.start / app.foreground / app.background JSON hooks

  const { execute, cancel, loading, error, result } = useFlow("flow.user.registration");
  const [form, setForm] = useState({ name: "", email: "", password: "", age: "25" });

  useFlowEvent("user.registered", (payload) => {
    console.log("verification email sent for", (payload as { userId: string }).userId);
  });

  const submit = () =>
    execute({
      input: { ...form, age: Number(form.age) },
    });

  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text variant="titleLarge">Create account</Text>
      <TextInput
        value={form.name}
        onChangeText={(name) => setForm((f) => ({ ...f, name }))}
        placeholder="Name"
      />
      <TextInput
        value={form.email}
        onChangeText={(email) => setForm((f) => ({ ...f, email }))}
        placeholder="Email"
      />
      <TextInput
        value={form.password}
        onChangeText={(password) => setForm((f) => ({ ...f, password }))}
        placeholder="Password"
        secure
      />
      <TextInput
        value={form.age}
        onChangeText={(age) => setForm((f) => ({ ...f, age }))}
        placeholder="Age"
      />
      {loading ? <Spinner /> : <Button onPress={submit}>Register</Button>}
      {loading && <Button onPress={cancel}>Cancel</Button>}
      {error && <Text color="red">{`${error.code}: ${error.message}`}</Text>}
      {result && <Text color="green">Welcome, {(result as { user: { name: string } }).user.name}!</Text>}
    </View>
  );
}
