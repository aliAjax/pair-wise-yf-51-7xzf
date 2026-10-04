<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import "../app.css";
  let { children } = $props();
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 5000 } } });
</script>
<QueryClientProvider {client}>{@render children()}</QueryClientProvider>
