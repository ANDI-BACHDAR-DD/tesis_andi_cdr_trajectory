// src/pages/VisualizationPage.js
import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useParams, useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Polyline, Circle } from 'react-leaflet';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { ArrowLeft, Brain, Loader2, MapPin, Activity, Clock, Radio, User } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { toast } from 'sonner';
import { API } from "../api/config";
import { Phone, MessageCircle, Globe, HelpCircle } from "lucide-react";
import SNAAnalysis from "../components/ui/SNAAnalysis";



// Fix Leaflet default marker icon (CDN fallback)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const COLORS = ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b'];

const VisualizationPage = () => {
  const { uploadId } = useParams();
  const navigate = useNavigate();
  const [records, setRecords] = useState([]);
  const [statistics, setStatistics] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [selectedPolyline, setSelectedPolyline] = useState(null);




  useEffect(() => {
    fetchData();

  }, [uploadId]);

  // === AI Chat Handler ===
  const handleSendMessage = async () => {
    if (!inputMessage.trim()) return;

    const userMsg = { sender: "user", text: inputMessage };
    setMessages(prev => [...prev, userMsg]);
    setInputMessage("");
    setChatLoading(true);

    try {
      const resp = await axios.post(`${API}/ask_chat`, {
        upload_id: uploadId,
        question: userMsg.text
      });

      let answer = resp.data.answer;

      // Jika answer berupa string, coba parse JSON
      if (typeof answer === "string") {
        try {
          answer = JSON.parse(answer);
        } catch (e) { }
      }

      let botText = "";

      // ======== SNA ========
      if (answer.type === "sna") {
        const top = answer.top_contacts || [];
        const stats = answer.sna_stats || {};
        botText =
          `🔗 *Analisis Social Network*\n\n` +
          `Top Kontak:\n` +
          (top.length > 0 ? top.map(c => `- ${c[0]}: ${c[1]}x`).join("\n") : "- Tidak ada data kontak") +
          `\n\nStatistik:\n` +
          `• Degree: ${stats.nodes > 0 ? "OK" : "0"}\n` +
          `• Nodes: ${stats.nodes}\n` +
          `• Edges: ${stats.edges}`;
      }

      // ======== SNA INTERACTION ========
      else if (answer.type === "sna_interaction") {
        const data = answer.data || [];
        botText = `🔗 *Interaksi Dua Arah*\n\n` +
          (data.length > 0 ? data.map(d => `- ${d.contact} (Weight: ${d.weight})`).join("\n") : "Tidak ditemukan interaksi dua arah yang signifikan.");
      }

      // ======== MAP / MOBILITY ========
      else if (answer.type === "map_response") {
        const mob = answer.mobility || {};
        const locs = answer.locations || [];

        botText = `📍 *Analisis Mobilitas*\n\n` +
          `Total Pergerakan: ${mob.total_movements || 0}\n\n` +
          `*Top Sites:*\n` +
          (mob.top_sites ? mob.top_sites.map(s => `- ${s[0]} (${s[1]}x)`).join("\n") : "-") +
          `\n\n*Hotspots (Koordinat):*\n` +
          (locs.map(l => `- [${l.lat}, ${l.long}] (${l.count}x)`).join("\n"));

        // Render Map Component inside chat
        if (locs.length > 0) {
          setMessages(prev => [...prev, {
            sender: "bot",
            text: botText,
            isMap: true,
            locations: locs
          }]);
          setChatLoading(false);
          return;
        }
      }

      // ======== ACTIVITY ========
      else if (answer.type === "activity") {
        const stats = answer.stats || {};
        botText = `📊 *Analisis Aktivitas*\n\n` +
          `Total: ${stats.total || 0}\n` +
          `Peak Hour: ${stats.peak_hour !== null ? stats.peak_hour + ":00" : "-"}\n` +
          `Peak Day: ${stats.peak_day || "-"}\n\n` +
          `*By Type:*\n` +
          (stats.by_type ? Object.entries(stats.by_type).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "-") +
          `\n\n*By Direction:*\n` +
          (stats.by_direction ? Object.entries(stats.by_direction).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "-");
      }

      // ======== FORENSIC ========
      else if (answer.type === "forensic") {
        const data = answer.data || {};
        const susp = data.suspicious_numbers || [];

        botText = `🕵‍♂ *Analisis Forensik*\n\n` +
          `Ditemukan ${data.flagged_count || 0} indikator mencurigakan.\n\n` +
          (susp.length > 0
            ? susp.map(s => `⚠ ${s.number}\n  Reason: ${s.reason}\n  Count: ${s.count}`).join("\n\n")
            : "✅ Tidak ada pola mencurigakan yang terdeteksi.");
      }

      // ======== TF-IDF MATCHES ========
      else if (answer.type === "tfidf" || answer.type === "tfidf_matches") {
        const matches = answer.matches || answer.samples || [];

        if (matches.length > 0) {
          botText = `📑 *Rekaman Terkait Pertanyaan*\n\n`;

          matches.forEach((m, idx) => {
            const rec = m.record || m;
            const score = m.score ? `(Score: ${m.score.toFixed(2)})` : "";

            botText += `*Result ${idx + 1}* ${score}\n`;
            botText += `• Date/Time: ${rec.date || "N/A"} ${rec.time || ""}\n`;
            botText += `• A-Number: ${rec.a_number || "N/A"}\n`;
            botText += `• B-Number: ${rec.b_number || "N/A"}\n`;
            botText += `• Activity: ${rec.calltype || "N/A"} (${rec.direction || "N/A"})\n`;

            if (rec.a_sitename) botText += `• Site: ${rec.a_sitename}\n`;
            if (rec.b_sitename) botText += `• Site B: ${rec.b_sitename}\n`;

            botText += `\n`;
          });
        } else {
          botText = "Maaf, tidak ditemukan rekaman yang relevan dengan pertanyaan Anda.";
        }
      }

      // ======== FALLBACK TEKS ========
      else {
        botText = typeof answer === "string"
          ? answer
          : (answer.text || JSON.stringify(answer, null, 2));
      }

      setMessages(prev => [...prev, { sender: "bot", text: botText }]);
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, {
        sender: "bot",
        text: "⚠ Terjadi error saat memproses pertanyaan."
      }]);
    }

    setChatLoading(false);
  };





  const fetchData = async () => {
    setLoading(true);
    try {
      // records
      const recordsResponse = await axios.get(`${API}/records/${uploadId}`);
      if (recordsResponse?.data) {
        // Support both { records: [...] } and { success: true, records: [...] }
        const recs = recordsResponse.data.records ?? recordsResponse.data;
        if (Array.isArray(recs)) {
          setRecords(recs);
        } else {
          setRecords([]);
        }
      } else {
        setRecords([]);
      }

      // statistics
      const statsResponse = await axios.get(`${API}/statistics/${uploadId}`);
      if (statsResponse?.data) {
        // backend may return object directly or wrapper
        const stats = statsResponse.data.statistics ?? statsResponse.data;
        setStatistics(stats || null);
      } else {
        setStatistics(null);
      }
    } catch (error) {
      console.error('Error fetching data:', error);
      toast.error('Gagal memuat data (cek backend / network).');
      setRecords([]);
      setStatistics(null);
    } finally {
      setLoading(false);
    }
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const response = await axios.post(`${API}/analyze`, {
        upload_id: uploadId,
        analysis_type: 'comprehensive'
      });
      if (response?.data?.success) {
        setAnalysis(response.data.analysis ?? response.data);
        toast.success(`Analisis selesai!`);
        // refresh to pick up interpolated updates
        fetchData();
      } else {
        // fallback: sometimes analysis returns directly
        setAnalysis(response?.data ?? null);
      }
    } catch (error) {
      console.error('Error analyzing:', error);
      toast.error('Gagal melakukan analisis: ' + (error.response?.data?.detail || error.message));
    } finally {
      setAnalyzing(false);
    }
  };



  // Only use numeric coordinates
  const validGpsRecords = useMemo(() => {
    return records.filter(r => {
      const lat = r?.a_lat;
      const lng = r?.a_long;
      return lat !== null && lat !== undefined && lng !== null && lng !== undefined && !Number.isNaN(Number(lat)) && !Number.isNaN(Number(lng));
    }).map(r => ({
      ...r,
      a_lat: Number(r.a_lat),
      a_long: Number(r.a_long)
    }));
  }, [records]);

  // map center fallback — ensure numbers
  const mapCenter = useMemo(() => {
    if (statistics?.gps_bounds && typeof statistics.gps_bounds.center_lat === 'number' && typeof statistics.gps_bounds.center_long === 'number') {
      return [statistics.gps_bounds.center_lat, statistics.gps_bounds.center_long];
    }
    if (validGpsRecords.length > 0) {
      const mid = Math.floor(validGpsRecords.length / 2);
      return [validGpsRecords[mid].a_lat, validGpsRecords[mid].a_long];
    }
    // default Bandung
    return [-6.9175, 107.6191];
  }, [statistics, validGpsRecords]);
  // Activity → Icon mapper
  const getActivityIcon = (type) => {
    const t = type?.toLowerCase() || "";

    if (t.includes("sms")) return <MessageCircle className="w-4 h-4 inline-block" />;
    if (t.includes("call") || t.includes("voice")) return <Phone className="w-4 h-4 inline-block" />;
    if (t.includes("data") || t.includes("internet") || t.includes("gprs"))
      return <Globe className="w-4 h-4 inline-block" />;

    return <HelpCircle className="w-4 h-4 inline-block" />;
  };
  // Color mapper for trajectory line by activity
  const getActivityColor = (type) => {
    if (!type) return "#999"; // default gray

    const t = type.toLowerCase();

    if (t.includes("call")) return "#4f46e5";     // Biru
    if (t.includes("sms")) return "#a855f7";      // Ungu
    if (t.includes("data") || t.includes("internet")) return "#22c55e"; // Hijau

    return "#999"; // fallback
  };



  // Activities & direction safe conversions
  const activityChartData = useMemo(() => {
    const dist = statistics?.activity_distribution;
    if (!dist || typeof dist !== 'object') return [];
    try {
      return Object.entries(dist).map(([name, value]) => ({ name, value: Number(value) || 0 }));
    } catch {
      return [];
    }
  }, [statistics]);

  const directionChartData = useMemo(() => {
    const dist = statistics?.direction_distribution;
    if (!dist || typeof dist !== 'object') return [];
    try {
      return Object.entries(dist).map(([name, value]) => ({ name, value: Number(value) || 0 }));
    } catch {
      return [];
    }
  }, [statistics]);

  // Loading UI
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #e0f2f7 0%, #f5f7fa 50%, #fce4ec 100%)' }}>
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin mx-auto mb-4" style={{ color: '#667eea' }} />
          <p className="text-lg font-semibold">Memuat data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(135deg, #e0f2f7 0%, #f5f7fa 50%, #fce4ec 100%)' }}>
      {/* Header */}
      <div className="glass-card border-b sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Button
                data-testid="back-button"
                variant="outline"
                onClick={() => navigate('/')}
                className="flex items-center space-x-2"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Kembali</span>
              </Button>
              <div>
                <h1 className="text-2xl font-bold gradient-text">Visualisasi Trajectory</h1>
                <p className="text-sm text-gray-600">{records.length} records</p>
              </div>
            </div>
            <Button
              data-testid="analyze-button"
              onClick={handleAnalyze}
              disabled={analyzing}
              className="flex items-center space-x-2"
              style={{
                background: analyzing ? '#9ca3af' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                border: 'none'
              }}
            >
              {analyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Menganalisis...</span>
                </>
              ) : (
                <>
                  <Brain className="w-4 h-4" />
                  <span>Analisis dengan AI</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">

        <Tabs defaultValue="map" className="space-y-6">
          <TabsList className="glass-card">
            <TabsTrigger value="map" data-testid="map-tab">Peta Trajectory</TabsTrigger>
            <TabsTrigger value="statistics" data-testid="statistics-tab">Statistik</TabsTrigger>
            <TabsTrigger value="analysis" data-testid="analysis-tab">Analisis AI</TabsTrigger>
            <TabsTrigger value="sna" data-testid="sna-tab">Analisis SNA</TabsTrigger>
            <TabsTrigger value="data" data-testid="data-tab">Data Detail</TabsTrigger>
          </TabsList>

          {/* Map Tab */}
          <TabsContent value="map" className="space-y-6">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <MapPin className="w-5 h-5" style={{ color: '#667eea' }} />
                  <span>Peta Trajectory GPS</span>
                </CardTitle>
                <CardDescription>
                  Visualisasi pergerakan pengguna berdasarkan koordinat GPS dari CDR
                </CardDescription>
              </CardHeader>
              {/* Legend for Activity Colors */}
              <div className="flex items-center space-x-6 mb-4 p-3 rounded-lg shadow"
                style={{ background: 'rgba(255, 255, 255, 0.7)', backdropFilter: 'blur(10px)' }}
              >
                <div className="flex items-center space-x-2">
                  <span style={{
                    display: 'inline-block',
                    width: '18px',
                    height: '4px',
                    backgroundColor: '#4f46e5',
                    borderRadius: '2px'
                  }}></span>
                  <span className="text-sm font-medium">CALL</span>
                </div>

                <div className="flex items-center space-x-2">
                  <span style={{
                    display: 'inline-block',
                    width: '18px',
                    height: '4px',
                    backgroundColor: '#a855f7',
                    borderRadius: '2px'
                  }}></span>
                  <span className="text-sm font-medium">SMS</span>
                </div>

                <div className="flex items-center space-x-2">
                  <span style={{
                    display: 'inline-block',
                    width: '18px',
                    height: '4px',
                    backgroundColor: '#22c55e',
                    borderRadius: '2px'
                  }}></span>
                  <span className="text-sm font-medium">DATA</span>
                </div>
              </div>

              <CardContent>
                <div style={{ height: '600px', borderRadius: '12px', overflow: 'hidden' }} data-testid="map-container">
                  {/* Only render MapContainer if center is numeric — MapContainer itself is forgiving but this avoids edgecases */}
                  {Array.isArray(mapCenter) && mapCenter.length === 2 ? (
                    <MapContainer
                      center={mapCenter}
                      zoom={13}
                      style={{ height: '100%', width: '100%' }}
                    >
                      <TileLayer
                        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                      />

                      {/* Trajectory segmented by activity */}
                      {validGpsRecords.length > 1 &&
                        validGpsRecords.map((r, i) => {
                          if (i === 0) return null; // skip first

                          const prev = validGpsRecords[i - 1];

                          const isSelected = selectedPolyline === i;

                          return (
                            <Polyline
                              key={`seg-${i}`}
                              positions={[
                                [prev.a_lat, prev.a_long],
                                [r.a_lat, r.a_long]
                              ]}
                              className={isSelected ? "animate-pulse-line" : ""}
                              pathOptions={{
                                color: isSelected ? '#ef4444' : getActivityColor(r.calltype),
                                weight: isSelected ? 8 : 4,
                                opacity: isSelected ? 1 : 0.9
                              }}
                              eventHandlers={{
                                click: () => setSelectedPolyline(i)
                              }}
                            >
                              <Popup>
                                <div className="space-y-1 text-sm min-w-[200px]">
                                  <div className="font-semibold text-purple-700 border-b pb-1 mb-1">Jalur Trajectory</div>
                                  <div className="text-xs space-y-2">
                                    <div>
                                      <strong className="text-gray-600">📍 Titik Asal (Record #{i}):</strong><br />
                                      Waktu: <span className="font-medium text-blue-600 bg-blue-50 px-1 py-0.5 rounded">{prev.time_readable || prev.time || "N/A"}</span><br />
                                      Lokasi: {prev.a_lat.toFixed(5)}, {prev.a_long.toFixed(5)}
                                    </div>
                                    <div className="border-t my-1"></div>
                                    <div>
                                      <strong className="text-gray-600">🎯 Titik Tujuan (Record #{i + 1}):</strong><br />
                                      Waktu: <span className="font-medium text-blue-600 bg-blue-50 px-1 py-0.5 rounded">{r.time_readable || r.time || "N/A"}</span><br />
                                      Lokasi: {r.a_lat.toFixed(5)}, {r.a_long.toFixed(5)}
                                    </div>
                                    <div className="border-t my-1"></div>
                                    <div>
                                      <strong className="text-gray-600">Aktivitas di Tujuan:</strong> {getActivityIcon(r.calltype)} {r.calltype || "N/A"}
                                    </div>
                                  </div>
                                </div>
                              </Popup>
                            </Polyline>
                          );
                        })
                      }


                      {/* Markers */}
                      {validGpsRecords.map((record, index) => (
                        <Marker
                          key={record.id || index}
                          position={[record.a_lat, record.a_long]}
                          eventHandlers={{
                            click: () => setSelectedRecord(record)
                          }}
                        >
                          <Popup>
                            <div className="space-y-2">
                              <div
                                className="font-bold text-sm"
                                style={{ color: "#667eea" }}
                              >
                                Record #{index + 1}
                              </div>

                              <div className="text-xs space-y-1">

                                <div><strong>Waktu:</strong>  <span className="font-medium text-blue-600 bg-blue-50 px-1 py-0.5 rounded">{record.time_readable || record.time || "N/A"}</span></div>
                                <div><strong>Latitude:</strong> {typeof record.a_lat === "number" ? record.a_lat.toFixed(6) : "N/A"}</div>
                                <div><strong>Longitude:</strong> {typeof record.a_long === "number" ? record.a_long.toFixed(6) : "N/A"}</div>

                                <div className="border-t my-1"></div>

                                <div><strong>IMEI:</strong> {record.a_imei || "N/A"}</div>
                                <div><strong>IMEI Type:</strong> {record.a_imei_type || "N/A"}</div>
                                <div><strong>IMSI:</strong> {record.a_imsi || "N/A"}</div>

                                <div className="border-t my-1"></div>

                                <div><strong>LAC/CID:</strong> {record.a_lac_cid || "N/A"}</div>
                                <div><strong>Site Name:</strong> {record.a_sitename || "N/A"}</div>

                                <div className="border-t my-1"></div>

                                <div><strong>User:</strong> {record.b_number || "N/A"}</div>

                                {/* Dengan Icon */}
                                <div>
                                  <strong>Activity:</strong> {getActivityIcon(record.calltype)} {record.calltype || "N/A"}
                                </div>

                                {record.interpolated && (
                                  <div className="text-orange-600">
                                    <strong>⚠ GPS Diinterpolasi</strong>
                                  </div>
                                )}
                              </div>
                            </div>
                          </Popup>


                        </Marker>
                      ))}

                      {/* Start and End markers with different colors */}
                      {validGpsRecords.length > 0 && (
                        <>
                          <Circle
                            center={[validGpsRecords[0].a_lat, validGpsRecords[0].a_long]}
                            radius={100}
                            pathOptions={{ color: '#43e97b', fillColor: '#43e97b', fillOpacity: 0.5 }}
                          />
                          <Circle
                            center={[validGpsRecords[validGpsRecords.length - 1].a_lat, validGpsRecords[validGpsRecords.length - 1].a_long]}
                            radius={100}
                            pathOptions={{ color: '#fa709a', fillColor: '#fa709a', fillOpacity: 0.5 }}
                          />
                        </>
                      )}
                    </MapContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-gray-500">
                      Tidak ada koordinat peta yang valid.
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Selected Record Details */}
            {selectedRecord && (
              <Card className="glass-card animate-fade-in">
                <CardHeader>
                  <CardTitle className="text-lg">Detail Record Terpilih</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 flex items-center space-x-1">
                        <Clock className="w-3 h-3" />
                        <span>Waktu (WIB)</span>
                      </div>
                      <div className="font-semibold text-xs text-blue-600 bg-blue-50 inline-block px-1 py-0.5 rounded mt-1">{selectedRecord.time_readable || selectedRecord.time || 'N/A'}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 flex items-center space-x-1">
                        <MapPin className="w-3 h-3" />
                        <span>Latitude</span>
                      </div>
                      <div className="font-semibold">{typeof selectedRecord.a_lat === 'number' ? selectedRecord.a_lat.toFixed(6) : 'N/A'}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 flex items-center space-x-1">
                        <MapPin className="w-3 h-3" />
                        <span>Longitude</span>
                      </div>
                      <div className="font-semibold">{typeof selectedRecord.a_long === 'number' ? selectedRecord.a_long.toFixed(6) : 'N/A'}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 flex items-center space-x-1">
                        <Radio className="w-3 h-3" />
                        <span>Cell Tower ID</span>
                      </div>
                      <div className="font-semibold text-xs">{selectedRecord.a_lac_cid || 'N/A'}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 flex items-center space-x-1">
                        <User className="w-3 h-3" />
                        <span>User ID</span>
                      </div>
                      <div className="font-semibold text-xs">{selectedRecord.b_number || 'N/A'}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500 flex items-center space-x-1">
                        <Activity className="w-3 h-3" />
                        <span>Activity Type</span>
                      </div>
                      <div className="font-semibold">{selectedRecord.calltype || 'N/A'}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500">Direction</div>
                      <div className="font-semibold">{selectedRecord.direction || 'N/A'}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-gray-500">Site Name</div>
                      <div className="font-semibold text-xs truncate">{selectedRecord.a_sitename || 'N/A'}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Statistics Tab */}
          <TabsContent value="statistics" className="space-y-6">
            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-sm">Total Records</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold" style={{ color: '#667eea' }}>
                    {typeof statistics?.total_records === 'number' ? statistics.total_records : (records.length || 0)}
                  </div>
                </CardContent>
              </Card>
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-sm">Records dengan GPS</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold" style={{ color: '#43e97b' }}>
                    {typeof statistics?.records_with_gps === 'number' ? statistics.records_with_gps : validGpsRecords.length}
                  </div>
                </CardContent>
              </Card>
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-sm">GPS Hilang</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold" style={{ color: '#fa709a' }}>
                    {typeof statistics?.missing_gps === 'number' ? statistics.missing_gps : Math.max(0, (records.length || 0) - validGpsRecords.length)}
                  </div>
                </CardContent>
              </Card>
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-sm">% GPS Hilang</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-3xl font-bold" style={{ color: '#f093fb' }}>
                    {typeof statistics?.missing_gps_percentage === 'number' ? statistics.missing_gps_percentage : (
                      records.length > 0 ? Math.round(((records.length - validGpsRecords.length) / records.length) * 100 * 100) / 100 : 0
                    )}%
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Activity Distribution */}
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle>Distribusi Tipe Aktivitas</CardTitle>
                </CardHeader>
                <CardContent>
                  {Array.isArray(activityChartData) && activityChartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={activityChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
                        <XAxis dataKey="name" />
                        <YAxis />
                        <Tooltip />
                        <Bar dataKey="value" fill="#667eea" radius={[8, 8, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="py-8 text-center text-gray-500">Tidak ada data aktivitas untuk ditampilkan.</div>
                  )}
                </CardContent>
              </Card>

              {/* Direction Distribution */}
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle>Distribusi Arah Komunikasi</CardTitle>
                </CardHeader>
                <CardContent>
                  {Array.isArray(directionChartData) && directionChartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={directionChartData}
                          cx="50%"
                          cy="50%"
                          labelLine={false}
                          label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                          outerRadius={100}
                          dataKey="value"
                        >
                          {directionChartData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="py-8 text-center text-gray-500">Tidak ada data arah untuk ditampilkan.</div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Analysis Tab */}
          <TabsContent value="analysis" className="space-y-6">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="text-lg font-bold" style={{ color: "#667eea" }}>
                  🔍 Analisis Cerdas (AI Chat)
                </CardTitle>
                <CardDescription>
                  Tanyakan apa saja terkait data CDR: nomor ini telepon siapa saja, siapa yang sering berada di lokasi sama, SNA, dll.
                </CardDescription>
              </CardHeader>

              <CardContent>

                {/* CHAT BOX */}
                <div
                  style={{
                    height: 300,
                    overflowY: "auto",
                    background: "white",
                    borderRadius: 8,
                    padding: 12,
                    border: "1px solid #ddd",
                    marginBottom: 12
                  }}
                >
                  {messages.map((msg, idx) => (
                    <div key={idx} className="mb-3">
                      <div
                        style={{
                          fontWeight: msg.sender === "user" ? "bold" : "normal",
                          color: msg.sender === "user" ? "#764ba2" : "#333"
                        }}
                      >
                        {msg.sender === "user" ? "Anda:" : "AI:"}
                      </div>
                      <div className="text-sm whitespace-pre-wrap">{msg.text}</div>

                      {/* Render Mini Map if response has map data */}
                      {msg.isMap && msg.locations && (
                        <div className="mt-2 h-48 w-full rounded-lg overflow-hidden border">
                          <MapContainer
                            center={[msg.locations[0].lat, msg.locations[0].long]}
                            zoom={13}
                            style={{ height: '100%', width: '100%' }}
                          >
                            <TileLayer
                              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                            />
                            {msg.locations.map((loc, i) => (
                              <Marker key={i} position={[loc.lat, loc.long]}>
                                <Popup>
                                  Location #{i + 1}<br />
                                  Count: {loc.count}
                                </Popup>
                              </Marker>
                            ))}
                          </MapContainer>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* INPUT */}
                <div className="flex space-x-2">
                  <input
                    className="flex-1 p-2 rounded border"
                    placeholder="Tanyakan sesuatu tentang data CDR..."
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                  />

                  <Button
                    onClick={handleSendMessage}
                    disabled={chatLoading}
                    style={{
                      background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
                      color: "white"
                    }}
                  >
                    {chatLoading ? "Mengirim..." : "Kirim"}
                  </Button>
                </div>

              </CardContent>
            </Card>
          </TabsContent>


          {/* Data Tab */}
          <TabsContent value="data" className="space-y-6">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle>Data CDR Detail</CardTitle>
                <CardDescription>Semua records dari file yang diupload</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b" style={{ borderColor: '#667eea' }}>
                        <th className="p-2 text-left">#</th>
                        <th className="p-2 text-left">Time</th>
                        <th className="p-2 text-left">Lat</th>
                        <th className="p-2 text-left">Long</th>
                        <th className="p-2 text-left">Cell Tower</th>
                        <th className="p-2 text-left">User</th>
                        <th className="p-2 text-left">Activity</th>
                        <th className="p-2 text-left">Direction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.slice(0, 50).map((record, index) => (
                        <tr key={record.id || index} className="border-b hover:bg-gray-50">
                          <td className="p-2">{index + 1}</td>
                          <td className="p-2 whitespace-nowrap">{record.time_readable || record.time || 'N/A'}</td>
                          <td className="p-2">{typeof record.a_lat === 'number' ? record.a_lat.toFixed(6) : (record.a_lat ? Number(record.a_lat).toFixed(6) : 'N/A')}</td>
                          <td className="p-2">{typeof record.a_long === 'number' ? record.a_long.toFixed(6) : (record.a_long ? Number(record.a_long).toFixed(6) : 'N/A')}</td>
                          <td className="p-2 text-xs">{record.a_lac_cid || 'N/A'}</td>
                          <td className="p-2 text-xs">{record.b_number || 'N/A'}</td>
                          <td className="p-2">{record.calltype || 'N/A'}</td>
                          <td className="p-2">{record.direction || 'N/A'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {records.length > 50 && (
                    <div className="mt-4 text-center text-sm text-gray-600">
                      Menampilkan 50 dari {records.length} records
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
          {/* SNA TAB */}
          <TabsContent value="sna" className="space-y-6">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="text-lg font-bold" style={{ color: "#667eea" }}>
                  🔗 Analisis Social Network (SNA)
                </CardTitle>
                <CardDescription>
                  Visualisasi hubungan antar nomor berdasarkan interaksi CDR.
                </CardDescription>
              </CardHeader>

              <CardContent>
                {/* ANALISIS TEKS */}
                <SNAAnalysis uploadId={uploadId} />

                {/* GRAPH SNA */}

              </CardContent>
            </Card>
          </TabsContent>


        </Tabs>
      </div>
    </div>
  );
};

export default VisualizationPage;
