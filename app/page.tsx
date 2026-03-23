"use client"

import { useState, useEffect } from "react"
import { CalendarView } from "@/components/calendar-view"
import { GoalManager } from "@/components/goal-manager"
import { PriorityDashboard } from "@/components/priority-dashboard"
import { GoogleIntegrations } from "@/components/google-integrations"
import { DocumentUpload } from "@/components/document-upload"
import { TasksView } from "@/components/tasks-view"
import { FocusModeView } from "@/components/focus-mode-view"
import { Sidebar } from "@/components/sidebar"
import { useAuth } from "@/components/auth/auth-provider"
import { EmailAuthForm } from "@/components/auth/email-auth-form"
import { Loader2 } from "lucide-react"
import ChatWidget from "@/components/chat_widget"
import { UserProfile } from "@/components/user-profile"

type AllowedView = "tasks" | "calendar" | "goals" | "priorities" | "focus" | "google" | "upload" | "profile"

export default function HomePage() {
  const [activeView, setActiveView] = useState<AllowedView>("tasks")
  const [refreshKey, setRefreshKey] = useState(0)
  const [isMobile, setIsMobile] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { user, loading, signOut } = useAuth()

  useEffect(() => {
    // Check if mobile on mount and on resize
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768)
    }
    
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Close sidebar when switching views on mobile
  const handleViewChange = (view: AllowedView) => {
    setActiveView(view)
    if (isMobile) {
      setSidebarOpen(false)
    }
  }

  const handleRefresh = () => {
    setRefreshKey(prev => prev + 1)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/50">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading your workspace…</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 px-4">
        <div className="max-w-6xl w-full grid gap-12 md:grid-cols-2 items-center">
          <div className="space-y-6 text-white">
            <p className="inline-flex items-center text-sm uppercase tracking-[0.3em] text-primary/80">
              AI calendar workspace
            </p>
            <h1 className="text-4xl md:text-5xl font-semibold leading-tight">
              Stay in flow with automated scheduling, focus, and planning.
            </h1>
            <p className="text-lg text-white/70">
              Create an account with your email to start syncing tasks, events, and documents securely through Supabase.
            </p>
            <ul className="space-y-3 text-white/80">
              <li>• Secure email/password authentication powered by Supabase Auth</li>
              <li>• Personal calendar, task lists, and AI document parsing</li>
              <li>• Data stored per-user with row level security</li>
            </ul>
          </div>
          <EmailAuthForm />
        </div>
      </div>
    )
  }

  const userId = user.id

  const renderView = () => {
    switch (activeView) {
      case "tasks":
        return <TasksView key={refreshKey} userId={userId} />
      case "goals":
        return <GoalManager key={refreshKey} userId={userId} />
      case "priorities":
        return <PriorityDashboard key={refreshKey} userId={userId} />
      case "focus":
        return <FocusModeView key={refreshKey} />
      case "google":
        return <GoogleIntegrations key={refreshKey} userId={userId} />
      case "upload":
        return <DocumentUpload key={refreshKey} userId={userId} />
      case "profile":
        return <UserProfile key={refreshKey} />
      case "calendar":
        return <CalendarView key={refreshKey} userId={userId} />
      default:
        return <TasksView key={refreshKey} userId={userId} />
    }
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar - Full height */}
      <aside className={`${
        isMobile 
          ? sidebarOpen ? 'fixed inset-0 z-40 w-64 transform transition-transform' : 'fixed -left-64 z-40 w-64 transform transition-transform'
          : 'w-64 flex-shrink-0'
      }`}>
        <Sidebar 
          activeView={activeView} 
          onViewChange={handleViewChange}
          userId={userId}
          onRefresh={handleRefresh}
          onSignOut={signOut}
        />
      </aside>

      {/* Mobile overlay when sidebar is open */}
      {isMobile && sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-30"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile Header - Hamburger Menu */}
        {isMobile && (
          <div className="bg-background border-b border-border/50 px-4 py-3 flex items-center gap-4 flex-shrink-0">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="p-2 hover:bg-muted rounded-lg transition-colors"
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h1 className="text-sm font-semibold capitalize">{activeView}</h1>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {renderView()}
          <ChatWidget 
            onSetActiveView={handleViewChange} 
            userId={userId}
            onFileUploaded={() => {
              if (activeView === 'upload') {
                handleRefresh()
              }
            }}
          />
        </div>

        {/* Mobile Bottom Navigation */}
        {isMobile && (
          <div className="w-full bg-background border-t border-border/50 glass-strong backdrop-blur-xl z-50 flex-shrink-0">
            <div className="flex justify-around h-16 items-center">
              <button 
                onClick={() => handleViewChange('tasks')}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition-colors ${
                  activeView === 'tasks' ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                Tasks
              </button>
              <button 
                onClick={() => handleViewChange('calendar')}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition-colors ${
                  activeView === 'calendar' ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                Calendar
              </button>
              <button 
                onClick={() => handleViewChange('goals')}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition-colors ${
                  activeView === 'goals' ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Goals
              </button>
              <button 
                onClick={() => handleViewChange('profile')}
                className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 text-xs font-medium transition-colors ${
                  activeView === 'profile' ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
                Profile
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
