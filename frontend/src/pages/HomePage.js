import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Upload, FileSpreadsheet, TrendingUp, MapPin, Activity, Share2, MessageCircle, FileText } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { API } from "../api/config";


//const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
//const API = `${BACKEND_URL}/api`;

const HomePage = () => {
  const [uploads, setUploads] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);  // 0-100
  const [uploadedMB, setUploadedMB] = useState(0);
  const [totalMB, setTotalMB] = useState(0);
  const fileInputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchUploads();
  }, []);

  const fetchUploads = async () => {
    try {
      const response = await axios.get(`${API}/uploads`);
      if (response.data.success) {
        setUploads(response.data.uploads);
      }
    } catch (error) {
      console.error('Error fetching uploads:', error);
    }
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();
    if (!['xlsx', 'xls', 'csv'].includes(ext)) {
      toast.error('Hanya file XLSX, XLS, atau CSV yang didukung');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadedMB(0);
    setTotalMB(parseFloat((file.size / (1024 * 1024)).toFixed(1)));

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await axios.post(`${API}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        // Large file uploads need a long timeout (e.g. 30 minutes for 2 GB)
        timeout: 30 * 60 * 1000,
        onUploadProgress: (progressEvent) => {
          const percentCompleted = Math.round(
            (progressEvent.loaded * 100) / (progressEvent.total || file.size)
          );
          const mbUploaded = parseFloat((progressEvent.loaded / (1024 * 1024)).toFixed(1));
          setUploadProgress(percentCompleted);
          setUploadedMB(mbUploaded);
        },
      });

      if (response.data.success) {
        setUploadProgress(100);
        toast.success(
          `✅ Berhasil! ${response.data.total_records.toLocaleString('id-ID')} records dari ${file.name}`
        );
        fetchUploads();
        // Reset file input
        if (fileInputRef.current) fileInputRef.current.value = '';
        setTimeout(() => {
          navigate(`/visualization/${response.data.upload_id}`);
        }, 1200);
      }
    } catch (error) {
      console.error('Error uploading file:', error);
      toast.error('Gagal mengupload file: ' + (error.response?.data?.detail || error.message));
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleViewVisualization = (uploadId) => {
    navigate(`/visualization/${uploadId}`);
  };

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(135deg, #e0f2f7 0%, #f5f7fa 50%, #fce4ec 100%)' }}>
      {/* Header */}
      <div className="glass-card border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center space-x-4">
            <div className="p-3 rounded-2xl" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
              <Activity className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold gradient-text">CDR Trajectory Analyzer</h1>
              <p className="text-sm text-gray-600 mt-1">Analisis Trajectory Manusia Berbasis AI dari Data CDR Telekomunikasi</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-12">
        {/* Upload Section */}
        <div className="animate-fade-in">
          <Card className="glass-card border-2 border-dashed" style={{ borderColor: '#667eea' }}>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <Upload className="w-6 h-6" style={{ color: '#667eea' }} />
                <span>Upload Data CDR</span>
              </CardTitle>
              <CardDescription>
                Upload file CDR (XLSX, XLS, atau CSV) dengan informasi GPS, timestamp, dan aktivitas pengguna.
                Mendukung file besar hingga 1-2 GB via streaming.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col items-center justify-center py-10 space-y-5">
                <div className="p-6 rounded-full" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
                  {uploading
                    ? <FileText className="w-12 h-12 text-white animate-pulse" />
                    : <FileSpreadsheet className="w-12 h-12 text-white" />}
                </div>

                <div className="text-center">
                  <h3 className="text-lg font-semibold mb-1">Upload File CDR</h3>
                  <p className="text-sm text-gray-500">
                    Format yang didukung: <strong>.xlsx</strong>, <strong>.xls</strong>, <strong>.csv</strong>
                  </p>
                  <p className="text-xs text-gray-400 mt-1">Ukuran file hingga 1-2 GB didukung untuk CSV</p>
                </div>

                {/* Progress bar — only visible while uploading */}
                {uploading && (
                  <div className="w-full max-w-sm space-y-2">
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>Mengupload...</span>
                      <span>{uploadedMB} MB / {totalMB} MB</span>
                    </div>
                    <div
                      className="w-full rounded-full overflow-hidden"
                      style={{ height: '10px', background: 'rgba(102,126,234,0.15)' }}
                    >
                      <div
                        style={{
                          width: `${uploadProgress}%`,
                          height: '100%',
                          background: 'linear-gradient(90deg, #667eea 0%, #764ba2 100%)',
                          transition: 'width 0.3s ease',
                          borderRadius: '9999px',
                        }}
                      />
                    </div>
                    <p className="text-center text-sm font-semibold" style={{ color: '#667eea' }}>
                      {uploadProgress}%
                    </p>
                  </div>
                )}

                <label htmlFor="file-upload">
                  <Button
                    data-testid="upload-cdr-button"
                    disabled={uploading}
                    className="cursor-pointer"
                    style={{
                      background: uploading ? '#9ca3af' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                      color: 'white',
                      border: 'none',
                      minWidth: '140px'
                    }}
                    asChild
                  >
                    <span>
                      {uploading ? `Mengupload ${uploadProgress}%` : 'Pilih File'}
                    </span>
                  </Button>
                </label>
                <input
                  id="file-upload"
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleFileUpload}
                  className="hidden"
                  disabled={uploading}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Uploaded Files List */}
        {uploads.length > 0 && (
          <div className="mt-12 animate-slide-in">
            <h2 className="text-2xl font-bold mb-6 flex items-center space-x-2">
              <TrendingUp className="w-6 h-6" style={{ color: '#667eea' }} />
              <span>Data Terupload</span>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {uploads.map((upload, index) => (
                <Card
                  key={upload.upload_id}
                  className="glass-card hover:shadow-xl cursor-pointer"
                  style={{
                    animation: `fadeIn 0.5s ease-out ${index * 0.1}s both`,
                    transform: 'translateY(0)',
                    transition: 'all 0.3s ease'
                  }}
                  onClick={() => handleViewVisualization(upload.upload_id)}
                  data-testid={`upload-card-${index}`}
                >
                  <CardHeader>
                    <CardTitle className="text-lg flex items-center space-x-2">
                      <MapPin className="w-5 h-5" style={{ color: '#667eea' }} />
                      <span className="truncate">{upload.filename}</span>
                    </CardTitle>
                    <CardDescription>
                      {new Date(upload.uploaded_at).toLocaleDateString('id-ID', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      <div className="flex justify-between items-center p-3 rounded-lg" style={{ background: 'rgba(102, 126, 234, 0.1)' }}>
                        <span className="text-sm font-medium text-gray-700">Total Records</span>
                        <span className="text-lg font-bold" style={{ color: '#667eea' }}>{upload.total_records}</span>
                      </div>
                      <Button
                        data-testid={`view-visualization-${index}`}
                        className="w-full"
                        style={{
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          color: 'white',
                          border: 'none'
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleViewVisualization(upload.upload_id);
                        }}
                      >
                        Lihat Visualisasi
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Features Section */}
        <div className="mt-16 animate-fade-in">
          <h2 className="text-2xl font-bold text-center mb-8">Fitur Utama</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              {
                icon: MapPin,
                title: 'Visualisasi Peta',
                description: 'Tampilkan trajectory pergerakan di peta interaktif dengan Leaflet/OpenStreetMap'
              },
              {
                icon: Share2,
                title: 'Analisis SNA',
                description: 'Analisis jaringan sosial dari data CDR untuk menemukan hubungan antar pengguna'
              },
              {
                icon: MessageCircle,
                title: 'Analisis Cerdas (AI Chat)',
                description: 'Tanya jawab interaktif dengan AI mengenai data CDR dan pola pergerakan'
              }
            ].map((feature, index) => (
              <Card key={index} className="glass-card text-center">
                <CardHeader>
                  <div className="mx-auto p-4 rounded-2xl w-fit" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
                    <feature.icon className="w-8 h-8 text-white" />
                  </div>
                  <CardTitle className="mt-4">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-gray-600">{feature.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HomePage;

