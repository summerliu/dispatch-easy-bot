"use client";
import { useState, useEffect } from "react";

export default function AdminDashboard() {
  const [users, setUsers] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [selectedUser, setSelectedUser] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [loading, setLoading] = useState(false);

  // 為了測試，這裡先提供一個跟假資料對應的列表
  // 實際上線時，可以改成從資料庫 fetch users 列表
  useEffect(() => {
    setUsers([
      { id: 1, name: "主管老王", role: "admin", telegram_id: true },
      { id: 2, name: "陳小明", role: "staff", telegram_id: true },
      { id: 3, name: "張小美", role: "staff", telegram_id: false }
    ]);
  }, []);

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) {
      alert("請選擇指派員工！");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, assigneeId: selectedUser, dueAt })
      });
      
      const result = await res.json();
      
      if (res.ok && result.success) {
        if (result.tgNotified) {
          alert(`🚀 派工成功！工單已寫入資料庫，且已同步發送 Telegram 推播給員工。`);
        } else {
          alert(`⚠️ 工單已建立，但 Telegram 發送失敗。\n原因：${result.notice}`);
        }
        setTitle("");
        setDueAt("");
        setSelectedUser("");
      } else {
        alert(`❌ 派工失敗：${result.error || "未知錯誤"}`);
      }
    } catch (error: any) {
      alert(`💥 連線後端 API 發生錯誤：${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="p-8 max-w-4xl mx-auto min-h-screen bg-gray-50">
      <h1 className="text-3xl font-bold mb-8 text-gray-800">DispatchEasy 智慧派工後台</h1>
      
      <div className="bg-white p-6 rounded-lg shadow-md border border-gray-200 mb-8">
        <h2 className="text-xl font-semibold mb-4 text-gray-700">🆕 新增指派任務</h2>
        <form onSubmit={handleAssign} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">任務內容</label>
            <input 
              type="text" 
              value={title} 
              onChange={e => setTitle(e.target.value)} 
              className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none text-black" 
              placeholder="例如：維修 A 棟冷氣、處理伺服器異常" 
              required 
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">指派員工</label>
            <select 
              value={selectedUser} 
              onChange={e => setSelectedUser(e.target.value)} 
              className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none text-black" 
              required
            >
              <option value="">-- 請選擇負責員工 --</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.role === "admin" ? "主管" : "員工"})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 mb-1">截止時間</label>
            <input 
              type="datetime-local" 
              value={dueAt} 
              onChange={e => setDueAt(e.target.value)} 
              className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-500 outline-none text-black" 
              required 
            />
          </div>
          <button 
            type="submit" 
            disabled={loading}
            className={`w-full bg-blue-600 text-white font-medium px-4 py-2 rounded hover:bg-blue-700 transition duration-200 ${loading ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            {loading ? "處理中..." : "送出派工"}
          </button>
        </form>
      </div>
    </main>
  );
}