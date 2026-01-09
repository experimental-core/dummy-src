#--------------------------------------------------------------
# Main Configuration - VPC Module
#--------------------------------------------------------------

module "vpc" {
  source = "./modules/vpc"

  vpc_name             = var.vpc_name
  cidr_range           = var.vpc_cidr
  region               = var.region
  public_subnet_count  = var.public_subnet_count
  private_subnet_count = var.private_subnet_count
}
