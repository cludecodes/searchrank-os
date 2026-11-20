import { redirect } from "next/navigation";
import { getRequestContext } from "@/core/auth/request";

export const dynamic = "force-dynamic";

export default async function Home() {
  const context = await getRequestContext();
  redirect(context ? "/dashboard" : "/login");
}
