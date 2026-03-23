"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MoreVertical, Plus, Pencil, Trash2, Sparkles } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TaskCard } from "./task-card"
import { type Task, type TaskPriority } from "@/lib/tasks"
import { type TaskList } from "@/lib/task-lists"
import { cn } from "@/lib/utils"
import { AIQuickCreate } from "./ai-quick-create"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface TaskListCardProps {
  list: TaskList
  tasks: Task[]
  onAddTask: (listId: string, title: string, options?: { priority?: TaskPriority }) => void
  onToggleComplete: (taskId: string, isCompleted: boolean) => void
  onToggleStarred: (taskId: string, isStarred: boolean) => void
  onTaskClick: (task: Task) => void
  onEditList: (listId: string) => void
  onDeleteList: (listId: string) => void
  userId: string
  onRefresh?: () => void
}

export function TaskListCard({
  list,
  tasks,
  onAddTask,
  onToggleComplete,
  onToggleStarred,
  onTaskClick,
  onEditList,
  onDeleteList,
  userId,
  onRefresh,
}: TaskListCardProps) {
  const [isAddingTask, setIsAddingTask] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState("")
  const [showAICreate, setShowAICreate] = useState(false)
  const [newTaskPriority, setNewTaskPriority] = useState<TaskPriority>("medium")

  const handleAddTask = () => {
    if (!newTaskTitle.trim()) return

    onAddTask(list.id, newTaskTitle.trim(), { priority: newTaskPriority })
    setNewTaskTitle("")
    setNewTaskPriority("medium")
    setIsAddingTask(false)
  }

  const incompleteTasks = tasks.filter(t => !t.is_completed)
  const completedTasks = tasks.filter(t => t.is_completed)

  return (
    <Card className="w-full glass hover-lift border-border/50 shadow-md hover:shadow-xl transition-all duration-300">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-4 h-4 rounded-full shadow-sm ring-2 ring-white/50"
              style={{ backgroundColor: list.color }}
            />
            <h2 className="text-lg font-semibold text-foreground">{list.name}</h2>
            <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {incompleteTasks.length}
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEditList(list.id)}>
                <Pencil className="h-4 w-4 mr-2" />
                Edit List
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => onDeleteList(list.id)}
                className="text-red-600"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete List
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {incompleteTasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onToggleComplete={onToggleComplete}
            onToggleStarred={onToggleStarred}
            onClick={onTaskClick}
          />
        ))}

        {completedTasks.length > 0 && (
          <div className="pt-3 mt-3 border-t border-border/50">
            <p className="text-xs text-muted-foreground mb-2 font-semibold uppercase tracking-wide">
              Completed ({completedTasks.length})
            </p>
            <div className="space-y-2">
              {completedTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onToggleComplete={onToggleComplete}
                  onToggleStarred={onToggleStarred}
                  onClick={onTaskClick}
                />
              ))}
            </div>
          </div>
        )}

        {isAddingTask ? (
          <div className="pt-4 space-y-3 bg-muted/30 p-4 rounded-lg">
            <Input
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTask()
                if (e.key === 'Escape') {
                  setIsAddingTask(false)
                  setNewTaskTitle("")
                }
              }}
              placeholder="Task title"
              className="h-10 text-sm w-full"
              autoFocus
            />
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <Label className="text-xs text-muted-foreground font-medium">Priority</Label>
              <Select value={newTaskPriority} onValueChange={(value) => setNewTaskPriority(value as TaskPriority)}>
                <SelectTrigger className="h-9 text-xs w-full sm:w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleAddTask}
                className="flex-1 h-9 text-sm"
              >
                Add Task
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setIsAddingTask(false)
                  setNewTaskTitle("")
                  setNewTaskPriority("medium")
                }}
                className="flex-1 h-9 text-sm"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-2 mt-3">
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:flex-1 justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-all duration-200 rounded-lg"
              onClick={() => setIsAddingTask(true)}
            >
              <Plus className="h-4 w-4 mr-2 transition-transform duration-200 group-hover:rotate-90" />
              Add a task
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto text-primary hover:text-primary hover:bg-primary/10 rounded-lg transition-all duration-200 hover:scale-110"
              onClick={() => setShowAICreate(true)}
              title="Quick create with AI"
            >
              <Sparkles className="h-4 w-4 mr-2" />
              <span className="sm:hidden">AI Create</span>
              <span className="hidden sm:inline">AI</span>
            </Button>
          </div>
        )}

        <AIQuickCreate
          isOpen={showAICreate}
          onClose={() => setShowAICreate(false)}
          userId={userId}
          onSuccess={() => {
            setShowAICreate(false)
            onRefresh?.()
          }}
        />
      </CardContent>
    </Card>
  )
}
