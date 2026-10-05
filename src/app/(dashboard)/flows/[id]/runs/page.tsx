import { redirect } from 'next/navigation';

// Runs now live inside the flow editor ("Execuções" tab). Kept as a
// redirect so existing links and bookmarks still land somewhere useful.
export default async function FlowRunsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/flows/${id}?tab=runs`);
}
