import "server-only";
import { revalidatePath } from "next/cache";

/** Every dashboard view reads live data, so mutations refresh the whole dashboard tree. */
export function revalidateDashboard(): void {
  revalidatePath("/", "layout");
}
