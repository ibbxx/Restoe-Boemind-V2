import type { ComponentProps } from "react";

type CardProps = ComponentProps<"div">;

export function Card({ className, ...props }: CardProps) {
  return <div className={["ui-card", className].filter(Boolean).join(" ")} {...props} />;
}

export function CardHeader({ className, ...props }: CardProps) {
  return <div className={["ui-card-header", className].filter(Boolean).join(" ")} {...props} />;
}

export function CardDescription({ className, ...props }: CardProps) {
  return <p className={["ui-card-description", className].filter(Boolean).join(" ")} {...props} />;
}

export function CardContent({ className, ...props }: CardProps) {
  return <div className={["ui-card-content", className].filter(Boolean).join(" ")} {...props} />;
}

export function CardFooter({ className, ...props }: CardProps) {
  return <div className={["ui-card-footer", className].filter(Boolean).join(" ")} {...props} />;
}
