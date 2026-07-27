import { Redirect, type Href } from "expo-router";

/** Land on the Sync tab. */
export default function Index() {
  return <Redirect href={"/sync" as Href} />;
}
