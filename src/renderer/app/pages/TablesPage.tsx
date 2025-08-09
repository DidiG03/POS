export default function TablesPage() {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Tables</h2>
      <div className="grid grid-cols-4 gap-3">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="p-4 rounded bg-gray-700 text-center">T{i + 1}</div>
        ))}
      </div>
    </div>
  );
}


